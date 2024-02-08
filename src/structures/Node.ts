/* eslint-disable no-case-declarations */
import { Dispatcher, Pool } from 'undici'
import WebSocket from 'ws'
import { Manager } from './Manager'
import { Player, PlayerTrack, UnresolvedPlayerTrack } from './Player'

function check(options: NodeOptions) {
    if (!options) throw new TypeError('NodeOptions must not be empty.')

    if (typeof options.host !== 'string' || !/.+/.test(options.host))
        throw new TypeError('Node option "host" must be present and be a non-empty string.')

    if (typeof options.port !== 'undefined' && typeof options.port !== 'number')
        throw new TypeError('Node option "port" must be a number.')

    if (
        typeof options.password !== 'undefined' &&
        (typeof options.password !== 'string' || !/.+/.test(options.password))
    )
        throw new TypeError('Node option "password" must be a non-empty string.')

    if (typeof options.secure !== 'undefined' && typeof options.secure !== 'boolean')
        throw new TypeError('Node option "secure" must be a boolean.')

    if (typeof options.identifier !== 'undefined' && typeof options.identifier !== 'string')
        throw new TypeError('Node option "identifier" must be a non-empty string.')

    if (typeof options.retryAmount !== 'undefined' && typeof options.retryAmount !== 'number')
        throw new TypeError('Node option "retryAmount" must be a number.')

    if (typeof options.retryDelay !== 'undefined' && typeof options.retryDelay !== 'number')
        throw new TypeError('Node option "retryDelay" must be a number.')

    if (typeof options.requestTimeout !== 'undefined' && typeof options.requestTimeout !== 'number')
        throw new TypeError('Node option "requestTimeout" must be a number.')
}

export class Node {
    /** The socket for the node. */
    public socket: WebSocket | null = null
    /** The client session ID */
    public sessionId: string
    /** The HTTP pool used for rest calls. */
    public http: Pool
    /** The amount of rest calls the node has made. */
    public calls = 0
    /** The stats for the node. */
    public stats: NodeStats
    public manager: Manager
    public version: NodeOptions['version']

    private static _manager: Manager
    private reconnectTimeout?: NodeJS.Timeout
    private reconnectAttempts = 1

    /** Returns if connected to the Node. */
    public get connected(): boolean {
        return this.socket?.readyState === WebSocket.OPEN
    }

    /** Returns the address for this node. */
    public get address(): string {
        return `${this.options.host}:${this.options.port}`
    }

    /** @hidden */
    public static init(manager: Manager): void {
        this._manager = manager
    }

    /**
     * Creates an instance of Node.
     * @param options
     */
    constructor(public options: NodeOptions) {
        if (!this.manager) this.manager = Node._manager
        if (!this.manager) throw new RangeError('Manager has not been initiated.')

        if (this.manager.nodes.has(options.identifier || options.host)) {
            return this.manager.nodes.get(options.identifier || options.host)
        }

        check(options)

        this.options = {
            port: 2333,
            password: 'youshallnotpass',
            secure: false,
            retryAmount: 5,
            retryDelay: 1000 * 30,
            ...options
        }

        if (this.options.secure) {
            this.options.port = 443
        }

        this.http = new Pool(`http${this.options.secure ? 's' : ''}://${this.address}`, this.options.poolOptions)

        this.options.identifier = options.identifier || options.host
        this.stats = {
            players: 0,
            playingPlayers: 0,
            uptime: 0,
            memory: {
                free: 0,
                used: 0,
                allocated: 0,
                reservable: 0
            },
            cpu: {
                cores: 0,
                systemLoad: 0,
                lavalinkLoad: 0
            },
            frameStats: {
                sent: 0,
                nulled: 0,
                deficit: 0
            }
        }

        this.version = options.version ?? 'v4'

        this.manager.nodes.set(this.options.identifier, this)
        this.manager.emit('nodeCreate', this)
    }

    /** Connects to the Node. */
    public connect(): void {
        if (this.connected) return

        const headers = {
            Authorization: this.options.password,
            'Num-Shards': String(this.manager.options.shards),
            'User-Id': this.manager.options.clientId,
            'Client-Name': this.manager.options.clientName
        }

        this.socket = new WebSocket(`ws${this.options.secure ? 's' : ''}://${this.address}/${this.version}/websocket`, {
            headers
        })

        this.socket.on('open', this.open.bind(this))
        this.socket.on('close', this.close.bind(this))
        this.socket.on('message', this.message.bind(this))
        this.socket.on('error', this.error.bind(this))
    }

    /** Destroys the Node and all players connected with it. */
    public destroy(): void {
        if (!this.connected) return

        const players = this.manager.players.filter(p => p.node.sessionId === this.sessionId)

        for (const [, player] of players) player.destroy()

        this.socket.close(1000, 'destroy')
        this.socket.removeAllListeners()
        this.socket = null

        this.reconnectAttempts = 1
        clearTimeout(this.reconnectTimeout)

        this.manager.emit('nodeDestroy', this)
        this.manager.destroyNode(this.options.identifier)
    }

    /**
     * Makes an API call to the Node
     * @param endpoint The endpoint that we will make the call to
     * @param modify Used to modify the request before being sent
     */
    public async makeRequest<T>(endpoint: string, modify?: ModifyRequest): Promise<T> {
        const options: Dispatcher.RequestOptions = {
            path: `/${this.version}/${endpoint.replace(/^\//gm, '')}`,
            method: 'GET',
            headers: {
                Authorization: this.options.password
            },
            headersTimeout: this.options.requestTimeout
        }

        modify?.(options)

        const request = await this.http.request(options)
        this.calls++

        try {
            return (await request.body.json()) as T
        } catch (err) {
            return null as T
        }
    }

    /**
     * Returns a list of players in this specific session.
     */
    public async getPlayers(): Promise<NodePlayer[]> {
        try {
            return await this.makeRequest(`/sessions/${this.sessionId}/players`)
        } catch (err) {
            throw new Error(`[Node#getPlayers]`, { cause: err })
        }
    }

    /**
     * Returns the player for this guild in this session.
     * @param guildId
     */
    public async getPlayer(guildId: string): Promise<NodePlayer> {
        try {
            return await this.makeRequest(`/sessions/${this.sessionId}/players/${guildId}`)
        } catch (err) {
            throw new Error(`[Node#getPlayer]`, { cause: err })
        }
    }

    /**
     * Updates or creates the player for this guild if it doesn't already exist.
     * @param guildId
     * @param data
     */
    public async updatePlayer(guildId: string, data: UpdatePlayer, noReplace = false): Promise<NodePlayer> {
        try {
            return await this.makeRequest(
                `/sessions/${this.sessionId}/players/${guildId}?noReplace=${!!noReplace}`,
                request => {
                    request.method = 'PATCH'
                    request.body = JSON.stringify(data)
                    request.headers['Content-Type'] = 'application/json'
                }
            )
        } catch (err) {
            throw new Error(`[Node#updatePlayer]:`, { cause: err })
        }
    }

    /**
     * Destroys the player for this guild in this session.
     * @param guildId
     */
    public async destroyPlayer(guildId: string) {
        try {
            return await this.makeRequest(`/sessions/${this.sessionId}/players/${guildId}`, request => {
                request.method = 'DELETE'
            })
        } catch (err) {
            throw new Error(`[Node#destroyPlayer]`, { cause: err })
        }
    }

    /**
     * Updates the session with the resuming state and timeout.
     * @param data
     */
    public async updateSession(data: UpdateSession): Promise<UpdateSession> {
        try {
            return await this.makeRequest(`/sessions/${this.sessionId}`, request => {
                request.method = 'PATCH'
                request.body = JSON.stringify(data)
                request.headers['Content-Type'] = 'application/json'
            })
        } catch (err) {
            throw new Error(`[Node#updateSession]`, { cause: err })
        }
    }

    /**
     * Resolves audio tracks.
     * @param identifier
     */
    public async loadTracks(identifier: string): Promise<TrackLoadingResult> {
        try {
            return await this.makeRequest(`/loadtracks?identifier=${encodeURIComponent(identifier)}`)
        } catch (err) {
            throw new Error(`[Node#loadTracks]`, { cause: err })
        }
    }

    /**
     * Decode a single track into its info, where BASE64 is the encoded base64 data.
     * @param encodedTrack
     */
    public async decodeTrack(encodedTrack: string): Promise<Track> {
        try {
            return await this.makeRequest(`/decodetrack?encodedTrack=${encodeURIComponent(encodedTrack)}`)
        } catch (err) {
            throw new Error(err)
        }
    }

    /**
     * Decodes multiple tracks into their info.
     * @param encodedTracks
     */
    public async decodeTracks(encodedTracks: string[]): Promise<Track[]> {
        try {
            return await this.makeRequest('/decodetracks', request => {
                request.method = 'POST'
                request.body = JSON.stringify(encodedTracks)
                request.headers['Content-Type'] = 'application/json'
            })
        } catch (err) {
            throw new Error(`[Node#decodeTracks]`, { cause: err })
        }
    }

    /**
     * Request Lavalink information.
     */
    public async getInfo(): Promise<NodeInfo> {
        try {
            return await this.makeRequest('/info')
        } catch (err) {
            throw new Error(`[Node#getInfo]`, { cause: err })
        }
    }

    /**
     * Request Lavalink information.
     */
    public async getVersion(): Promise<NodeVersion> {
        try {
            return await this.makeRequest('/version', options => (options.path = options.path.replace(/^\/v\d+/, '')))
        } catch (err) {
            throw new Error(`[Node#getVersion]`, { cause: err })
        }
    }

    /**
     * Request Lavalink statistics.
     */
    public async getStats(): Promise<NodeStats> {
        try {
            return await this.makeRequest('/stats')
        } catch (err) {
            throw new Error(`[Node#getStats]`, { cause: err })
        }
    }

    private reconnect(): void {
        this.reconnectTimeout = setTimeout(() => {
            if (this.reconnectAttempts >= this.options.retryAmount) {
                const error = new Error(`Unable to connect after ${this.options.retryAmount} attempts.`)

                this.manager.emit('nodeError', this, error)
                return this.destroy()
            }

            this.socket.removeAllListeners()
            this.socket = null
            this.manager.emit('nodeReconnect', this)
            this.connect()
            this.reconnectAttempts++
        }, this.options.retryDelay)
    }

    protected open(): void {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
        this.manager.emit('nodeConnect', this)
    }

    protected close(code: number, reason: string): void {
        this.manager.emit('nodeDisconnect', this, { code, reason })
        if (code !== 1000 || reason !== 'destroy') this.reconnect()
    }

    protected error(error: Error): void {
        if (!error) return
        this.manager.emit('nodeError', this, error)
    }

    protected message(d: Buffer | string): void {
        if (Array.isArray(d)) d = Buffer.concat(d)
        else if (d instanceof ArrayBuffer) d = Buffer.from(d)

        const payload = JSON.parse(d.toString())

        if (!payload.op) return
        this.manager.emit('nodeRaw', payload)

        switch (payload.op) {
            case 'stats':
                delete payload.op
                this.stats = { ...payload } as unknown as NodeStats
                break
            case 'playerUpdate':
                const player = this.manager.players.get(payload.guildId)
                if (player) player.position = payload.state.position || 0
                break
            case 'event':
                this.handleEvent(payload)
                break
            case 'ready':
                this.sessionId = payload.sessionId
                break
            default:
                this.manager.emit(
                    'nodeError',
                    this,
                    new Error(`Unexpected op "${payload.op}" with data: ${JSON.stringify(payload)}`)
                )
                return
        }
    }

    protected handleEvent(payload: NodeEventOP & NodeEvents): void {
        if (!payload.guildId) return

        const player = this.manager.players.get(payload.guildId)
        if (!player) return

        const track = player.queue.current
        const type = payload.type

        if (payload.type === 'TrackStartEvent') {
            this.trackStart(player, track as PlayerTrack, payload)
        } else if (payload.type === 'TrackEndEvent') {
            this.trackEnd(player, track as PlayerTrack, payload)
        } else if (payload.type === 'TrackStuckEvent') {
            this.trackStuck(player, track as PlayerTrack, payload)
        } else if (payload.type === 'TrackExceptionEvent') {
            this.trackError(player, track, payload)
        } else if (payload.type === 'WebSocketClosedEvent') {
            this.socketClosed(player, payload)
        } else {
            this.manager.emit('nodeError', this, new Error(`Node#event unknown event '${type}'.`))
        }
    }

    protected trackStart(player: Player, track: PlayerTrack, payload: TrackStartEvent): void {
        player.playing = true
        player.paused = false
        this.manager.emit('trackStart', player, track, payload)
    }

    protected trackEnd(player: Player, track: PlayerTrack, payload: TrackEndEvent): void {
        // If a track had an error while starting
        if (['LOAD_FAILED', 'CLEAN_UP'].includes(payload.reason)) {
            player.queue.previous = player.queue.current
            player.queue.current = player.queue.shift()

            if (!player.queue.current) return this.queueEnd(player, track, payload)

            this.manager.emit('trackEnd', player, track, payload)
            if (this.manager.options.autoPlay) player.play()

            return
        }

        // If a track was forcibly played
        if (payload.reason === 'replaced') {
            this.manager.emit('trackEnd', player, track, payload)
            return
        }

        // If a track ended and is track repeating
        if (track && player.trackRepeat) {
            if (payload.reason === 'stopped') {
                player.queue.previous = player.queue.current
                player.queue.current = player.queue.shift()
            }

            if (!player.queue.current) return this.queueEnd(player, track, payload)

            this.manager.emit('trackEnd', player, track, payload)
            if (this.manager.options.autoPlay) player.play()

            return
        }

        // If a track ended and is queue repeating
        if (track && player.queueRepeat) {
            player.queue.previous = player.queue.current

            if (payload.reason === 'stopped') {
                player.queue.current = player.queue.shift()
                if (!player.queue.current) return this.queueEnd(player, track, payload)
            } else {
                player.queue.add(player.queue.current)
                player.queue.current = player.queue.shift()
            }

            this.manager.emit('trackEnd', player, track, payload)
            if (this.manager.options.autoPlay) player.play()

            return
        }

        // If there is another song in the queue
        if (player.queue.length) {
            player.queue.previous = player.queue.current
            player.queue.current = player.queue.shift()

            this.manager.emit('trackEnd', player, track, payload)
            if (this.manager.options.autoPlay) player.play()

            return
        }

        // If there are no songs in the queue
        if (!player.queue.length) return this.queueEnd(player, track, payload)
    }

    protected queueEnd(player: Player, track: PlayerTrack, payload: TrackEndEvent): void {
        player.queue.current = null
        player.playing = false
        this.manager.emit('queueEnd', player, track, payload)
    }

    protected trackStuck(player: Player, track: PlayerTrack, payload: TrackStuckEvent): void {
        player.stop()
        this.manager.emit('trackStuck', player, track, payload)
    }

    protected trackError(
        player: Player,
        track: PlayerTrack | UnresolvedPlayerTrack,
        payload: TrackExceptionEvent
    ): void {
        player.stop()
        this.manager.emit('trackError', player, track, payload)
    }

    protected socketClosed(player: Player, payload: WebSocketClosedEvent): void {
        this.manager.emit('socketClosed', player, payload)
    }
}

export interface NodeOptions {
    /** The host for the node. */
    host: string
    /** The port for the node. */
    port?: number
    /** The password for the node. */
    password?: string
    /** Whether the host uses SSL. */
    secure?: boolean
    /** The identifier for the node. */
    identifier?: string
    /** The retryAmount for the node. */
    retryAmount?: number
    /** The retryDelay for the node. */
    retryDelay?: number
    /** The timeout used for api calls. */
    requestTimeout?: number
    /** Options for the undici http pool used for http requests. */
    poolOptions?: Pool.Options
    /** The Lavalink node version. */
    version?: 'v4'
}

export type NodeOP = NodeReadyOP | NodePlayerUpdateOP | NodeStatsOP | NodeEventOP

/** Dispatched by Lavalink upon successful connection and authorization. Contains fields determining if resuming was successful, as well as the session id. */
export interface NodeReadyOP {
    op: 'ready'
    /** Whether this session was resumed. */
    resumed: boolean
    /** The Lavalink session id of this connection. Not to be confused with a Discord voice session id. */
    sessionId: string
}

/** Dispatched every x seconds (configurable in application.yml) with the current state of the player. */
export interface NodePlayerUpdateOP {
    op: 'playerUpdate'
    /** The guild id of the player. */
    guildId: string
    /** The player state. */
    state: PlayerState
}

export interface PlayerState {
    /** Unix timestamp in milliseconds. */
    time: number
    /** The position of the track in milliseconds. */
    position: number
    /** Whether Lavalink is connected to the voice gateway. */
    connected: boolean
    /** The ping of the node to the Discord voice server in milliseconds (-1 if not connected). */
    ping: number
}

export interface NodeStatsOP extends NodeStats {
    op: 'stats'
}

export interface NodeStats {
    /** The amount of players on the node. */
    players: number
    /** The amount of playing players on the node. */
    playingPlayers: number
    /** The uptime for the node. */
    uptime: number
    /** The memory stats for the node. */
    memory: NodeMemoryStats
    /** The cpu stats for the node. */
    cpu: NodeCPUStats
    /** The frame stats for the node. */
    frameStats?: NodeFrameStats
}

export interface NodeMemoryStats {
    /** The free memory of the allocated amount. */
    free: number
    /** The used memory of the allocated amount. */
    used: number
    /** The total allocated memory. */
    allocated: number
    /** The reservable memory. */
    reservable: number
}

export interface NodeCPUStats {
    /** The core amount the host machine has. */
    cores: number
    /** The system load. */
    systemLoad: number
    /** The lavalink load. */
    lavalinkLoad: number
}

export interface NodeFrameStats {
    /** The amount of sent frames. */
    sent: number
    /** The amount of nulled frames. */
    nulled: number
    /** The amount of deficit frames. */
    deficit: number
}

export interface NodeEventOP {
    op: 'event'
    /** The type of event. */
    type: NodeEventType
    /** The guild id. */
    guildId: string
}

export type NodeEventType =
    | 'TrackStartEvent'
    | 'TrackEndEvent'
    | 'TrackExceptionEvent'
    | 'TrackStuckEvent'
    | 'WebSocketClosedEvent'

export type NodeEvents = TrackStartEvent | TrackEndEvent | TrackExceptionEvent | TrackStuckEvent | WebSocketClosedEvent

export interface TrackStartEvent extends NodeEventOP {
    type: 'TrackStartEvent'
    /** The track that started playing. */
    track: Track
}

export interface TrackEndEvent extends NodeEventOP {
    type: 'TrackEndEvent'
    /** The track that ended playing. */
    track: Track
    /** The reason the track ended. */
    reason: TrackEndReason
}

export type TrackEndReason = 'finished' | 'loadFailed' | 'stopped' | 'replaced' | 'cleanup'

export interface TrackExceptionEvent extends NodeEventOP {
    type: 'TrackExceptionEvent'
    /** The track that threw the exception. */
    track: Track
    /** The occurred exception. */
    exception: Exception
}

export interface Exception {
    /** The message of the exception. */
    message: string
    /** The severity of the exception. */
    severity: Severity
    /** The cause of the exception. */
    cause: string
}

/**
 * `common` - The cause is known and expected, indicates that there is nothing wrong with the library itself.
 *
 * `suspicious` - The cause might not be exactly known, but is possibly caused by outside factors.
 * For example when an outside service responds in a format that we do not expect.
 *
 * `fault` - The probable cause is an issue with the library or there is no way to tell what the cause might be.
 * This is the default level and other levels are used in cases where the thrower has more in-depth knowledge about the error.
 */
export type Severity = 'common' | 'suspicious' | 'fault'

export interface TrackStuckEvent extends NodeEventOP {
    type: 'TrackStuckEvent'
    /** The track that got stuck. */
    track: Track
    /** The threshold in milliseconds that was exceeded. */
    thresholdMs: number
}

export interface WebSocketClosedEvent extends NodeEventOP {
    type: 'WebSocketClosedEvent'
    /** The Discord close event code. */
    code: number
    /** The close reason. */
    reason: string
    /** Whether the connection was closed by Discord. */
    byRemote: boolean
}

export interface Track {
    /** The base64 encoded track data. */
    encoded: string
    /** Info about the track. */
    info: TrackInfo
    /** Addition track info provided by plugins. */
    pluginInfo: object
    /** Additional track data provided via the Update Player endpoint. */
    userData: object
}

export interface TrackInfo {
    /** The track identifier. */
    identifier: string
    /** Whether the track is seekable. */
    isSeekable: boolean
    /** The track author. */
    author: string
    /** The track length in milliseconds. */
    length: number
    /** Whether the track is a stream. */
    isStream: boolean
    /** The track position in milliseconds. */
    position: number
    /** The track title. */
    title: string
    /** The track uri. */
    uri: string | null
    /** The track artwork url. */
    artworkUrl: string | null
    /** The track ISRC. */
    isrc: string | null
    /** The track source name. */
    sourceName: string
}

export interface PlaylistInfo {
    /** The name of the playlist. */
    name: string
    /** The selected track of the playlist (-1 if no track is selected) */
    selectedTrack: number
}

export type TrackLoadingResult =
    | TrackResultData
    | PlaylistResultData
    | SearchResultData
    | EmptyResultResult
    | ErrorResultData
/**
 * `track` - A track has been loaded.
 *
 * `playlist` - A playlist has been loaded.
 *
 * `search` - A search result has been loaded.
 *
 * `empty` - There has been no matches for your identifier.
 *
 * `error` - Loading has failed with an error.
 */
export type LoadResultType = 'track' | 'playlist' | 'search' | 'empty' | 'error'

export interface TrackResultData {
    loadType: 'track'
    data: Track
}

export interface PlaylistResultData {
    loadType: 'playlist'
    data: {
        /** The info of the playlist. */
        info: PlaylistInfo
        /** Addition playlist info provided by plugins. */
        pluginInfo: object
        /** The tracks of the playlist. */
        tracks: Track[]
    }
}

export interface SearchResultData {
    loadType: 'search'
    data: Track[]
}

export interface EmptyResultResult {
    loadType: 'empty'
    data: object
}

export interface ErrorResultData {
    loadType: 'error'
    data: Exception
}

/** Modifies any outgoing REST requests. */
export type ModifyRequest = (options: Dispatcher.RequestOptions) => void

export interface NodePlayer {
    /** The guild id of the player. */
    guildId: string
    /** The currently playing track. */
    track?: Track
    /** The volume of the player, range 0-1000, in percentage. */
    volume: number
    /** Whether the player is paused. */
    paused: boolean
    /** The state of the player. */
    state: PlayerState
    /** The voice state of the player. */
    voice: VoiceState
    /** The filters used by the player. */
    filters: Filters
}

export interface VoiceState {
    /** The Discord voice token to authenticate with. */
    token: string
    /** The Discord voice endpoint to connect to. */
    endpoint: string
    /** The Discord voice session id to authenticate with. */
    sessionId: string
}

export interface Filters {
    /** Adjusts the player volume from 0.0 to 5.0, where 1.0 is 100%. Values >1.0 may cause clipping. */
    volume?: number
    /** Adjusts 15 different bands. */
    equalizer?: EqualizerFilter[]
    /** Eliminates part of a band, usually targeting vocals. */
    karaoke?: KaraokeFilter
    /** Changes the speed, pitch, and rate. */
    timescale?: TimescaleFilter
    /** Creates a shuddering effect, where the volume quickly oscillates. */
    tremolo?: TremoloFilter
    /** Creates a shuddering effect, where the pitch quickly oscillates. */
    vibrato?: VibratoFilter
    /** Rotates the audio around the stereo channels/user headphones (aka Audio Panning). */
    rotation?: RotationFilter
    /** Distorts the audio. */
    distortion?: DistortionFilter
    /** Mixes both channels (left and right). */
    channelMix?: ChannelMixFilter
    /** Filters higher frequencies. */
    lowPass?: LowPassFilter
    /** Filter plugin configurations. */
    pluginFilters?: {
        [key: string]: any
    }
}

export interface EqualizerFilter {
    /** The band (0 to 14). */
    band: number
    /** The gain (-0.25 to 1.0). */
    gain: number
}

export interface KaraokeFilter {
    /** The level (0 to 1.0 where 0.0 is no effect and 1.0 is full effect). */
    level?: number
    /** The mono level (0 to 1.0 where 0.0 is no effect and 1.0 is full effect). */
    monoLevel?: number
    /** The filter band (in Hz). */
    filterBand?: number
    /** The filter width. */
    filterWidth?: number
}

export interface TimescaleFilter {
    /** The playback speed 0.0 ≤ x. */
    speed?: number
    /** The pitch 0.0 ≤ x. */
    pitch?: number
    /** The rate 0.0 ≤ x. */
    rate?: number
}

export interface TremoloFilter {
    /** The frequency 0.0 < x. */
    frequency?: number
    /** The tremolo depth 0.0 < x ≤ 1.0. */
    depth?: number
}

export interface VibratoFilter {
    /** The frequency 0.0 < x ≤ 14.0. */
    frequency?: number
    /** The vibrato depth 0.0 < x ≤ 1.0. */
    depth?: number
}

export interface RotationFilter {
    /** The frequency of the audio rotating around the listener in Hz. 0.2 is similar to the example video above. */
    rotationHz?: number
}

export interface DistortionFilter {
    /** The sin offset. */
    sinOffset?: number
    /** The sin scale. */
    sinScale?: number
    /** The cos offset. */
    cosOffset?: number
    /** The cos scale. */
    cosScale?: number
    /** The tan offset. */
    tanOffset?: number
    /** The tan scale. */
    tanScale?: number
    /** The offset. */
    offset?: number
    /** The scale. */
    scale?: number
}

export interface ChannelMixFilter {
    /** The left to left channel mix factor (0.0 ≤ x ≤ 1.0). */
    leftToLeft?: number
    /** The left to right channel mix factor (0.0 ≤ x ≤ 1.0). */
    leftToRight?: number
    /** The right to left channel mix factor (0.0 ≤ x ≤ 1.0). */
    rightToLeft?: number
    /** The right to right channel mix factor (0.0 ≤ x ≤ 1.0). */
    rightToRight?: number
}

export interface LowPassFilter {
    /** The smoothing factor (1.0 < x). */
    smoothing?: number
}

export interface UpdatePlayer {
    track?: UpdatePlayerTrack
    /**
     * The base64 encoded track to play. `null` stops the current track.
     * @deprecated
     */
    encodedTrack?: string
    /**
     * The identifier of the track to play.
     * @deprecated
     */
    identifier?: string
    /** The track position in milliseconds. */
    position?: number
    /** The track end time in milliseconds (must be > 0). `null` resets this if it was set previously. */
    endTime?: number
    /** The player volume, in percentage, from 0 to 1000. */
    volume?: number
    /** Whether the player is paused. */
    paused?: boolean
    /** The new filters to apply. This will override all previously applied filters. */
    filters?: Filters
    /** Information required for connecting to Discord. */
    voice?: VoiceState
}

export interface UpdatePlayerTrack {
    /** The base64 encoded track to play. `null` stops the current track. */
    encoded?: string
    /** The identifier of the track to play. */
    identifier?: string
    /** Additional track data to be sent back in the Track Object. */
    userData: object
}

export interface UpdateSession {
    /** Whether resuming is enabled for this session or not */
    resuming?: boolean
    /** The timeout in seconds (default is 60s) */
    timeout?: number
}

export interface NodeInfo {
    /** The version of this Lavalink server. */
    version: NodeVersion
    /** The millisecond unix timestamp when this Lavalink jar was built. */
    buildTime: number
    /** The git information of this Lavalink server. */
    git: NodeGit
    /** The JVM version this Lavalink server runs on. */
    jvm: string
    /** The Lavaplayer version being used by this server. */
    lavaplayer
    /** The enabled source managers for this server. */
    sourceManagers: string[]
    /** The enabled filters for this server. */
    filters: string[]
    /** The enabled plugins for this server */
    plugins: NodePlugin[]
}

export interface NodeVersion {
    /** The full version string of this Lavalink server. */
    semver: string
    /** The major version of this Lavalink server. */
    major: number
    /** The minor version of this Lavalink server. */
    minor: number
    /** The patch version of this Lavalink server. */
    patch: number
    /** The pre-release version according to semver as a `.` separated list of identifiers. */
    preRelease: string | null
    /** The build metadata according to semver as a `.` separated list of identifiers */
    build: string | null
}

export interface NodeGit {
    /** The branch this Lavalink server was built on. */
    branch: string
    /** The commit this Lavalink server was built on. */
    commit: string
    /** The millisecond unix timestamp for when the commit was created. */
    commitTime: number
}

export interface NodePlugin {
    /** The name of the plugin. */
    name: string
    /** The version of the plugin. */
    version: string
}
