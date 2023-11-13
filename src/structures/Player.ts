import { Manager, SearchQuery, SearchResult } from './Manager'
import { Node, PlayerData, PlayerFilters } from './Node'
import { Queue } from './Queue'
import { State, TrackUtils, VoiceState } from './Utils'

function check(options: PlayerOptions) {
    if (!options) throw new TypeError('PlayerOptions must not be empty.')

    if (!/^\d+$/.test(options.guildId))
        throw new TypeError('Player option "guild" must be present and be a non-empty string.')

    if (options.textChannelId && !/^\d+$/.test(options.textChannelId))
        throw new TypeError('Player option "textChannel" must be a non-empty string.')

    if (options.voiceChannelId && !/^\d+$/.test(options.voiceChannelId))
        throw new TypeError('Player option "voiceChannel" must be a non-empty string.')

    if (options.node && typeof options.node !== 'string')
        throw new TypeError('Player option "node" must be a non-empty string.')

    if (typeof options.volume !== 'undefined' && typeof options.volume !== 'number')
        throw new TypeError('Player option "volume" must be a number.')

    if (typeof options.selfMute !== 'undefined' && typeof options.selfMute !== 'boolean')
        throw new TypeError('Player option "selfMute" must be a boolean.')

    if (typeof options.selfDeafen !== 'undefined' && typeof options.selfDeafen !== 'boolean')
        throw new TypeError('Player option "selfDeafen" must be a boolean.')
}

export class Player {
    /** The Queue for the Player. */
    public readonly queue = new Queue()
    /** Whether the queue repeats the track. */
    public trackRepeat = false
    /** Whether the queue repeats the queue. */
    public queueRepeat = false
    /** A mode of music playback in which songs are played in a randomized order. */
    public shufflePlay = false
    /** The time the player is in the track. */
    public position = 0
    /** Whether the player is playing. */
    public playing = false
    /** Whether the player is paused. */
    public paused = false
    /** The volume for the player */
    public volume: number
    /** The Node for the Player. */
    public node: Node
    /** The guild ID for the player. */
    public guildId: string
    /** The voice channel ID for the player. */
    public voiceChannelId: string | null = null
    /** The text channel ID for the player. */
    public textChannelId: string | null = null
    /** The current state of the player. */
    public state: State = 'DISCONNECTED'
    /** The voice state object from Discord. */
    public voiceState: VoiceState
    /** The Manager. */
    public manager: Manager

    private static _manager: Manager
    private readonly data: Record<string, unknown> = {}

    /**
     * Set custom data.
     * @param key
     * @param value
     */
    public set(key: string, value: unknown): void {
        this.data[key] = value
    }

    /**
     * Get custom data.
     * @param key
     */
    public get<T>(key: string): T {
        return this.data[key] as T
    }

    /** @hidden */
    public static init(manager: Manager): void {
        this._manager = manager
    }

    /**
     * Creates a new player, returns one if it already exists.
     * @param options
     */
    constructor(public options: PlayerOptions) {
        if (!this.manager) this.manager = Player._manager
        if (!this.manager) throw new RangeError('Manager has not been initiated.')

        if (this.manager.players.has(options.guildId)) {
            return this.manager.players.get(options.guildId)
        }

        check(options)

        this.guildId = options.guildId
        this.voiceState = Object.assign({ op: 'voiceUpdate', guildId: options.guildId })

        if (options.voiceChannelId) this.voiceChannelId = options.voiceChannelId
        if (options.textChannelId) this.textChannelId = options.textChannelId

        const node = this.manager.nodes.get(options.node)
        this.node = node || this.manager.leastLoadNodes.first()

        if (!this.node) throw new RangeError('No available nodes.')

        this.manager.players.set(options.guildId, this)
        this.manager.emit('playerCreate', this)
        this.setVolume(options.volume ?? 100)
    }

    /**
     * Same as Manager#search() but a shortcut on the player itself.
     * @param query
     * @param requester
     */
    public search(query: string | SearchQuery, requester?: unknown): Promise<SearchResult> {
        return this.manager.search(query, requester)
    }

    /** Connect to the voice channel. */
    public connect(): this {
        if (!this.voiceChannelId) throw new RangeError('No voice channel has been set.')

        this.state = 'CONNECTING'

        this.manager.options.send(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: this.voiceChannelId,
                self_mute: this.options.selfMute || false,
                self_deaf: this.options.selfDeafen || false
            }
        })

        this.state = 'CONNECTED'

        return this
    }

    /** Disconnect from the voice channel. */
    public async disconnect(): Promise<this> {
        if (this.voiceChannelId === null) return this

        this.state = 'DISCONNECTING'

        await this.pause(true)
        this.manager.options.send(this.guildId, {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: null,
                self_mute: false,
                self_deaf: false
            }
        })

        this.voiceChannelId = null
        this.state = 'DISCONNECTED'

        return this
    }

    /** Destroys the player. */
    public async destroy(disconnect = true): Promise<void> {
        this.state = 'DESTROYING'

        if (disconnect) {
            await this.disconnect()
        }

        await this.node.destroyPlayer(this.guildId)
        this.manager.emit('playerDestroy', this)
        this.manager.players.delete(this.guildId)
    }

    /**
     * Sets the player voice channel.
     * @param channel
     */
    public setVoiceChannelId(channelId: string): this {
        if (typeof channelId !== 'string') throw new TypeError('Channel must be a non-empty string.')

        this.voiceChannelId = channelId
        this.connect()

        return this
    }

    /**
     * Sets the player text channel.
     * @param channel
     */
    public setTextChannelId(channelId: string): this {
        if (typeof channelId !== 'string') throw new TypeError('Channel must be a non-empty string.')

        this.textChannelId = channelId

        return this
    }

    /** Plays the next track. */
    public async play(): Promise<PlayerData>

    /**
     * Plays the specified track.
     * @param track
     */
    public async play(track: Track | UnresolvedTrack): Promise<PlayerData>

    /**
     * Plays the next track with some options.
     * @param options
     */
    public async play(options: PlayOptions): Promise<PlayerData>

    /**
     * Plays the specified track with some options.
     * @param track
     * @param options
     */
    public async play(track: Track | UnresolvedTrack, options: PlayOptions): Promise<PlayerData>
    public async play(
        optionsOrTrack?: PlayOptions | Track | UnresolvedTrack,
        playOptions?: PlayOptions
    ): Promise<PlayerData> {
        if (typeof optionsOrTrack !== 'undefined' && TrackUtils.validate(optionsOrTrack)) {
            if (this.queue.current) this.queue.previous = this.queue.current
            this.queue.current = optionsOrTrack as Track
        }

        if (!this.queue.current) throw new RangeError('No current track.')

        const options = playOptions
            ? playOptions
            : ['position', 'endTime', 'noReplace'].every(v => Object.keys(optionsOrTrack || {}).includes(v))
            ? (optionsOrTrack as PlayOptions)
            : {}

        if (TrackUtils.isUnresolvedTrack(this.queue.current)) {
            try {
                this.queue.current = await TrackUtils.getClosestTrack(this.queue.current as UnresolvedTrack)
            } catch (err) {
                this.manager.emit('trackError', this, this.queue.current, err)
                if (this.queue[0]) return this.play(this.queue[0])
                return
            }
        }

        let track = this.queue.current.track

        if (typeof track !== 'string') {
            track = (track as Track).track
        }

        return await this.node.updatePlayer(
            this.guildId,
            {
                encodedTrack: track,
                position: options.position,
                endTime: options.endTime
            },
            options.noReplace
        )
    }

    /**
     * Sets the player volume.
     * @param volume
     */
    public async setVolume(volume: number): Promise<this> {
        volume = Number(volume)

        if (isNaN(volume)) throw new TypeError('Volume must be a number.')
        this.volume = Math.max(Math.min(volume, 1000), 0)

        await this.node.updatePlayer(this.guildId, { volume: this.volume })

        return this
    }

    /**
     * Sets the track repeat.
     * @param repeat
     */
    public setTrackRepeat(repeat: boolean): this {
        if (typeof repeat !== 'boolean') throw new TypeError('Repeat can only be "true" or "false".')

        this.trackRepeat = repeat
        this.queueRepeat = false

        return this
    }

    /**
     * Sets the queue repeat.
     * @param repeat
     */
    public setQueueRepeat(repeat: boolean): this {
        if (typeof repeat !== 'boolean') throw new TypeError('Repeat can only be "true" or "false".')

        this.queueRepeat = repeat
        this.trackRepeat = false

        return this
    }

    public setShufflePlay(enabled: boolean): this {
        if (typeof enabled !== 'boolean') throw new TypeError('Enabled can only be "true" or "false".')

        this.shufflePlay = enabled

        if (this.shufflePlay) {
            this.queue.shuffle()
        } else {
            this.queue.unshuffle()
        }

        return this
    }

    /** Stops the current track, optionally give an amount to skip to, e.g 5 would play the 5th song. */
    public async stop(amount?: number): Promise<this> {
        if (typeof amount === 'number' && amount > 1) {
            if (amount > this.queue.length) throw new RangeError('Cannot skip more than the queue length.')

            this.queue.splice(0, amount - 1)
        }

        await this.node.updatePlayer(this.guildId, { encodedTrack: null })

        return this
    }

    /**
     * Pauses the current track.
     * @param pause
     */
    public async pause(pause: boolean): Promise<this> {
        if (typeof pause !== 'boolean') throw new RangeError('Pause can only be "true" or "false".')
        // If already paused or the queue is empty do nothing https://github.com/MenuDocs/erela.js/issues/58
        if (this.paused === pause || !this.queue.totalSize) return this

        this.playing = !pause
        this.paused = pause

        await this.node.updatePlayer(this.guildId, { paused: pause })

        return this
    }

    /**
     * Seeks to the position in the current track.
     * @param position
     */
    public async seek(position: number): Promise<this> {
        if (!this.queue.current) return

        position = Number(position)

        if (isNaN(position)) {
            throw new RangeError('Position must be a number.')
        }

        if (position < 0 || position > this.queue.current.duration) {
            position = Math.max(Math.min(position, this.queue.current.duration), 0)
        }

        this.position = position

        await this.node.updatePlayer(this.guildId, { position: this.position })

        return this
    }

    public async setFilters(filters: PlayerFilters): Promise<PlayerData> {
        return await this.node.updatePlayer(this.guildId, { filters })
    }
}

export interface PlayerOptions {
    /** The guild ID the Player belongs to. */
    guildId: string
    /** The text channel ID the Player belongs to. */
    textChannelId: string
    /** The voice channel ID the Player belongs to. */
    voiceChannelId?: string
    /** The node the Player uses. */
    node?: string
    /** The initial volume the Player will use. */
    volume?: number
    /** If the player should mute itself. */
    selfMute?: boolean
    /** If the player should deaf itself. */
    selfDeafen?: boolean
}

/** If track partials are set some of these will be `undefined` as they were removed. */
export interface Track {
    /** The base64 encoded track. */
    readonly track: string
    /** The identifier of the track. */
    readonly identifier: string
    /** If the track is seekable. */
    readonly isSeekable: boolean
    /** The author of the track. */
    readonly author: string
    /** The duration of the track. */
    readonly duration: number
    /** If the track is a stream.. */
    readonly isStream: boolean
    /** The track position in milliseconds. */
    readonly position: number
    /** The title of the track. */
    readonly title: string
    /** The uri of the track. */
    readonly uri: string
    /** The thumbnail of the track or null if it's a unsupported source. */
    readonly artworkUrl: string | null
    /** The track ISRC. */
    readonly isrc: string | null
    /** The track source name. */
    readonly sourceName: string
    /** The user that requested the track. */
    readonly requester: unknown | null
    /** The timestamp when the track was builded. */
    readonly buildedAt: number
}

/** Unresolved tracks can't be played normally, they will resolve before playing into a Track. */
export interface UnresolvedTrack extends Partial<Track> {
    /** The title to search against. */
    title: string
    /** The author to search against. */
    author?: string
    /** The duration to search within 1500 milliseconds of the results from YouTube. */
    duration?: number
    /** Resolves into a Track. */
    resolve(): Promise<void>
}

export interface PlayOptions {
    /** The position to start the track. */
    readonly position?: number
    /** The position to end the track. */
    readonly endTime?: number
    /** Whether to not replace the track if a play payload is sent. */
    readonly noReplace?: boolean
}
