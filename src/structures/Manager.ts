import { Collection } from '@discordjs/collection'
import { EventEmitter } from 'events'
import {
    LoadResultType,
    Node,
    NodeOptions,
    TrackEndEvent,
    TrackExceptionEvent,
    TrackLoadingResult,
    TrackStartEvent,
    TrackStuckEvent,
    WebSocketClosedEvent
} from './Node'
import { Player, PlayerOptions, PlayerTrack, UnresolvedPlayerTrack } from './Player'
import { TrackUtils } from './Utils'

function check(options: ManagerOptions) {
    if (!options) throw new TypeError('ManagerOptions must not be empty.')

    if (typeof options.send !== 'function') throw new TypeError('Manager option "send" must be present and a function.')

    if (typeof options.clientId !== 'undefined' && !/^\d+$/.test(options.clientId))
        throw new TypeError('Manager option "clientId" must be a non-empty string.')

    if (typeof options.nodes !== 'undefined' && !Array.isArray(options.nodes))
        throw new TypeError('Manager option "nodes" must be a array.')

    if (typeof options.shards !== 'undefined' && typeof options.shards !== 'number')
        throw new TypeError('Manager option "shards" must be a number.')

    if (typeof options.autoPlay !== 'undefined' && typeof options.autoPlay !== 'boolean')
        throw new TypeError('Manager option "autoPlay" must be a boolean.')

    if (typeof options.trackPartial !== 'undefined' && !Array.isArray(options.trackPartial))
        throw new TypeError('Manager option "trackPartial" must be a string array.')

    if (typeof options.clientName !== 'undefined' && typeof options.clientName !== 'string')
        throw new TypeError('Manager option "clientName" must be a string.')

    if (typeof options.defaultSearchPlatform !== 'undefined' && typeof options.defaultSearchPlatform !== 'string')
        throw new TypeError('Manager option "defaultSearchPlatform" must be a string.')
}

export interface Manager {
    /**
     * Emitted when a Node is created.
     * @event Manager#nodeCreate
     */
    on(event: 'nodeCreate', listener: (node: Node) => void): this

    /**
     * Emitted when a Node is destroyed.
     * @event Manager#nodeDestroy
     */
    on(event: 'nodeDestroy', listener: (node: Node) => void): this

    /**
     * Emitted when a Node connects.
     * @event Manager#nodeConnect
     */
    on(event: 'nodeConnect', listener: (node: Node) => void): this

    /**
     * Emitted when a Node reconnects.
     * @event Manager#nodeReconnect
     */
    on(event: 'nodeReconnect', listener: (node: Node) => void): this

    /**
     * Emitted when a Node disconnects.
     * @event Manager#nodeDisconnect
     */
    on(event: 'nodeDisconnect', listener: (node: Node, reason: { code?: number; reason?: string }) => void): this

    /**
     * Emitted when a Node has an error.
     * @event Manager#nodeError
     */
    on(event: 'nodeError', listener: (node: Node, error: Error) => void): this

    /**
     * Emitted whenever any Lavalink event is received.
     * @event Manager#nodeRaw
     */
    on(event: 'nodeRaw', listener: (payload: unknown) => void): this

    /**
     * Emitted when a player is created.
     * @event Manager#playerCreate
     */
    on(event: 'playerCreate', listener: (player: Player) => void): this

    /**
     * Emitted when a player is destroyed.
     * @event Manager#playerDestroy
     */
    on(event: 'playerDestroy', listener: (player: Player) => void): this

    /**
     * Emitted when a player queue ends.
     * @event Manager#queueEnd
     */
    on(
        event: 'queueEnd',
        listener: (player: Player, track: PlayerTrack | UnresolvedPlayerTrack, payload: TrackEndEvent) => void
    ): this

    /**
     * Emitted when a player is moved to a new voice channel.
     * @event Manager#playerMove
     */
    on(event: 'playerMove', listener: (player: Player, initChannel: string, newChannel: string) => void): this

    /**
     * Emitted when a player is disconnected from it's current voice channel.
     * @event Manager#playerDisconnect
     */
    on(event: 'playerDisconnect', listener: (player: Player, oldChannel: string) => void): this

    /**
     * Emitted when a track starts.
     * @event Manager#trackStart
     */
    on(event: 'trackStart', listener: (player: Player, track: PlayerTrack, payload: TrackStartEvent) => void): this

    /**
     * Emitted when a track ends.
     * @event Manager#trackEnd
     */
    on(event: 'trackEnd', listener: (player: Player, track: PlayerTrack, payload: TrackEndEvent) => void): this

    /**
     * Emitted when a track gets stuck during playback.
     * @event Manager#trackStuck
     */
    on(event: 'trackStuck', listener: (player: Player, track: PlayerTrack, payload: TrackStuckEvent) => void): this

    /**
     * Emitted when a track has an error during playback.
     * @event Manager#trackError
     */
    on(
        event: 'trackError',
        listener: (player: Player, track: PlayerTrack | UnresolvedPlayerTrack, payload: TrackExceptionEvent) => void
    ): this

    /**
     * Emitted when a voice connection is closed.
     * @event Manager#socketClosed
     */
    on(event: 'socketClosed', listener: (player: Player, payload: WebSocketClosedEvent) => void): this
}

/**
 * The main hub for interacting with Lavalink and using Erela.JS,
 * @noInheritDoc
 */
export class Manager extends EventEmitter {
    public static readonly DEFAULT_SOURCES: Record<SearchPlatform, string> = {
        'youtube music': 'ytmsearch',
        youtube: 'ytsearch',
        soundcloud: 'scsearch'
    }

    /** The map of players. */
    public readonly players = new Collection<string, Player>()
    /** The map of nodes. */
    public readonly nodes = new Collection<string, Node>()
    /** The options that were set. */
    public readonly options: ManagerOptions
    private initiated = false

    /** Returns the least used Nodes. */
    public get leastUsedNodes(): Collection<string, Node> {
        return this.nodes.filter(node => node.connected).sort((a, b) => b.calls - a.calls)
    }

    /** Returns the least system load Nodes. */
    public get leastLoadNodes(): Collection<string, Node> {
        return this.nodes
            .filter(node => node.connected)
            .sort((a, b) => {
                const aload = a.stats.cpu ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100 : 0
                const bload = b.stats.cpu ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100 : 0
                return aload - bload
            })
    }

    /**
     * Initiates the Manager class.
     * @param options
     */
    constructor(options: ManagerOptions) {
        super()

        check(options)

        Player.init(this)
        Node.init(this)
        TrackUtils.init(this)

        if (options.trackPartial) {
            TrackUtils.setTrackPartial(options.trackPartial)
            delete options.trackPartial
        }

        this.options = {
            nodes: [{ identifier: 'default', host: 'localhost' }],
            shards: 1,
            autoPlay: true,
            clientName: 'erela.js',
            defaultSearchPlatform: 'youtube',
            ...options
        }

        if (this.options.nodes) {
            for (const nodeOptions of this.options.nodes) new Node(nodeOptions)
        }
    }

    /**
     * Initiates the Manager.
     * @param clientId
     */
    public init(clientId?: string): this {
        if (this.initiated) return this
        if (typeof clientId !== 'undefined') this.options.clientId = clientId

        if (typeof this.options.clientId !== 'string') throw new Error('"clientId" set is not type of "string"')

        if (!this.options.clientId)
            throw new Error('"clientId" is not set. Pass it in Manager#init() or as a option in the constructor.')

        for (const node of this.nodes.values()) {
            try {
                node.connect()
            } catch (err) {
                this.emit('nodeError', node, err)
            }
        }

        this.initiated = true

        return this
    }

    /**
     * Searches the enabled sources based off the URL or the `source` property.
     * @param query
     * @param requester
     * @returns The search result.
     */
    public async search(query: string | SearchQuery, requester?: unknown): Promise<SearchResult> {
        const node = this.leastUsedNodes.first()

        if (!node) throw new Error('No available nodes.')

        const _query: SearchQuery = typeof query === 'string' ? { query } : query,
            _source = Manager.DEFAULT_SOURCES[_query.source ?? this.options.defaultSearchPlatform] ?? _query.source

        let search = _query.query

        if (!/^https?:\/\//.test(search)) {
            search = `${_source}:${search}`
        }

        let loadingResult: TrackLoadingResult

        try {
            loadingResult = await node.loadTracks(search)
        } catch (err) {
            throw new Error(`Failed to load tracks (${err.message}).`)
        }

        const result: SearchResult = {
            loadType: loadingResult.loadType,
            tracks: []
        }

        if (loadingResult.loadType === 'track') {
            result.tracks = [TrackUtils.build(loadingResult.data, requester)]
        }

        if (loadingResult.loadType === 'playlist') {
            result.tracks = loadingResult.data.tracks.map(i => TrackUtils.build(i, requester))

            result.playlist = {
                name: loadingResult.data.info.name,
                selectedTrack:
                    loadingResult.data.info.selectedTrack === -1
                        ? null
                        : TrackUtils.build(loadingResult.data.tracks[loadingResult.data.info.selectedTrack], requester),
                duration: result.tracks.reduce((acc: number, cur: PlayerTrack) => acc + (cur.duration || 0), 0)
            }
        }

        if (loadingResult.loadType === 'search') {
            result.tracks = loadingResult.data.map(i => TrackUtils.build(i, requester))
        }

        if (loadingResult.loadType === 'error') {
            result.exception = loadingResult.data
        }

        return result
    }

    /**
     * Creates a player or returns one if it already exists.
     * @param options
     */
    public create(options: PlayerOptions): Player {
        if (this.players.has(options.guildId)) {
            return this.players.get(options.guildId)
        }

        return new Player(options)
    }

    /**
     * Returns a player or undefined if it does not exist.
     * @param guild
     */
    public get(guild: string): Player | undefined {
        return this.players.get(guild)
    }

    /**
     * Destroys a player if it exists.
     * @param guild
     */
    public destroy(guild: string): void {
        this.players.delete(guild)
    }

    /**
     * Creates a node or returns one if it already exists.
     * @param options
     */
    public createNode(options: NodeOptions): Node {
        if (this.nodes.has(options.identifier || options.host)) {
            return this.nodes.get(options.identifier || options.host)
        }

        return new Node(options)
    }

    /**
     * Destroys a node if it exists.
     * @param identifier
     */
    public destroyNode(identifier: string): void {
        const node = this.nodes.get(identifier)
        if (!node) return

        node.destroy()
        this.nodes.delete(identifier)
    }

    /**
     * Sends voice data to the Lavalink server.
     * @param data
     */
    public async updateVoiceState(data: DiscordVoicePacket): Promise<void> {
        if ('t' in data && !['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(data.t)) return

        const update: DiscordVoiceServer | DiscordVoiceState = data.d
        if (!update || (!('token' in update) && !('session_id' in update))) return

        const player = this.players.get(update.guild_id) as Player
        if (!player) return

        if ('token' in update) {
            /* voice server update */
            player.voiceState.token = update.token
            player.voiceState.endpoint = update.endpoint
        } else {
            /* voice state update */
            if (update.user_id !== this.options.clientId) {
                return
            }

            if (update.channel_id) {
                if (player.voiceChannelId !== update.channel_id) {
                    /* we moved voice channels. */
                    this.emit('playerMove', player, player.voiceChannelId, update.channel_id)
                }

                player.voiceState.sessionId = update.session_id
                player.voiceChannelId = update.channel_id
            } else {
                /* player got disconnected. */
                this.emit('playerDisconnect', player, player.voiceChannelId)
                player.voiceChannelId = null
                player.voiceState = Object.assign({})
                player.pause(true)
            }
        }

        if (['token', 'endpoint', 'sessionId'].every(key => key in player.voiceState)) {
            await player.node.updatePlayer(player.guildId, {
                voice: {
                    token: player.voiceState.token,
                    endpoint: player.voiceState.endpoint,
                    sessionId: player.voiceState.sessionId
                }
            })
        }
    }
}

export interface ManagerOptions {
    /** The array of nodes to connect to. */
    nodes?: NodeOptions[]
    /** The client ID to use. */
    clientId?: string
    /** Value to use for the `Client-Name` header. */
    clientName?: string
    /** The shard count. */
    shards?: number
    /** Whether players should automatically play the next song. */
    autoPlay?: boolean
    /** An array of track properties to keep. `track` will always be present. */
    trackPartial?: string[]
    /** The default search platform to use, can be "youtube", "youtube music", or "soundcloud". */
    defaultSearchPlatform?: SearchPlatform
    /**
     * Function to send data to the websocket.
     * @param id
     * @param payload
     */
    send(id: string, payload: Payload): void
}

export interface Payload {
    /** The OP code */
    op: number
    d: {
        guild_id: string
        channel_id: string | null
        self_mute: boolean
        self_deaf: boolean
    }
}

export interface SearchQuery {
    /** The source to search from. */
    source?: SearchPlatform | string
    /** The query to search for. */
    query: string
}

export type SearchPlatform = 'youtube' | 'youtube music' | 'soundcloud'

export interface SearchResult {
    /** The load type of the result. */
    loadType: LoadResultType
    /** The array of tracks from the result. */
    tracks: PlayerTrack[]
    /** The playlist info if the load type is "playlist". */
    playlist?: PlaylistResultInfo
    /** The exception when searching if one. */
    exception?: {
        /** The message for the exception. */
        message: string
        /** The severity of exception. */
        severity: string
    }
}

export interface PlaylistResultInfo {
    /** The playlist name. */
    name: string
    /** The playlist selected track. */
    selectedTrack?: PlayerTrack
    /** The duration of the playlist. */
    duration: number
}

export interface DiscordVoicePacket {
    t?: 'VOICE_SERVER_UPDATE' | 'VOICE_STATE_UPDATE'
    d: DiscordVoiceState | DiscordVoiceServer
}

export interface DiscordVoiceServer {
    token: string
    guild_id: string
    endpoint: string
}

export interface DiscordVoiceState {
    guild_id: string
    user_id: string
    session_id: string
    channel_id: string
}
