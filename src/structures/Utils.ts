import { Manager } from './Manager'
import { Track } from './Node'
import { PlayerTrack, UnresolvedPlayerTrack } from './Player'

/** @hidden */
const TRACK_SYMBOL = Symbol('track'),
    /** @hidden */
    UNRESOLVED_TRACK_SYMBOL = Symbol('unresolved')

/** @hidden */
const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export abstract class TrackUtils {
    static trackPartial: string[] | null = null
    private static manager: Manager

    /** @hidden */
    public static init(manager: Manager): void {
        this.manager = manager
    }

    static setTrackPartial(partial: string[]): void {
        if (!Array.isArray(partial) || !partial.every(str => typeof str === 'string'))
            throw new Error('Provided partial is not an array or not a string array.')
        if (!partial.includes('track')) partial.unshift('track')

        this.trackPartial = partial
    }

    /**
     * Checks if the provided argument is a valid Track or UnresolvedTrack, if provided an array then every element will be checked.
     * @param trackOrTracks
     */
    static validate(trackOrTracks: unknown): boolean {
        if (typeof trackOrTracks === 'undefined') throw new RangeError('Provided argument must be present.')

        if (Array.isArray(trackOrTracks) && trackOrTracks.length) {
            for (const track of trackOrTracks) {
                if (!(track[TRACK_SYMBOL] || track[UNRESOLVED_TRACK_SYMBOL])) return false
            }

            return true
        }

        return (trackOrTracks[TRACK_SYMBOL] || trackOrTracks[UNRESOLVED_TRACK_SYMBOL]) === true
    }

    /**
     * Checks if the provided argument is a valid UnresolvedTrack.
     * @param track
     */
    static isUnresolvedTrack(track: unknown): boolean {
        if (typeof track === 'undefined') throw new RangeError('Provided argument must be present.')

        return track[UNRESOLVED_TRACK_SYMBOL] === true
    }

    /**
     * Checks if the provided argument is a valid Track.
     * @param track
     */
    static isTrack(track: unknown): boolean {
        if (typeof track === 'undefined') throw new RangeError('Provided argument must be present.')

        return track[TRACK_SYMBOL] === true
    }

    /**
     * Builds a Track from the raw data from Lavalink and a optional requester.
     * @param data
     * @param requester
     */
    static build(data: Track, requester?: unknown): PlayerTrack {
        if (typeof data === 'undefined') throw new RangeError('Argument "data" must be present.')

        try {
            const track: PlayerTrack = {
                track: data.encoded,
                identifier: data.info.identifier,
                isSeekable: data.info.isSeekable,
                author: data.info.author,
                duration: data.info.length,
                isStream: data.info.isStream,
                position: data.info.position,
                title: data.info.title,
                uri: data.info.uri,
                artworkUrl: data.info.artworkUrl,
                isrc: data.info.isrc,
                sourceName: data.info.sourceName,
                requester,
                buildedAt: Date.now()
            }

            if (this.trackPartial) {
                for (const key of Object.keys(track)) {
                    if (this.trackPartial.includes(key)) continue
                    delete track[key]
                }
            }

            Object.defineProperty(track, TRACK_SYMBOL, {
                configurable: true,
                value: true
            })

            return track
        } catch (error) {
            throw new RangeError(`Argument "data" is not a valid track: ${error.message}`)
        }
    }

    /**
     * Builds a UnresolvedTrack to be resolved before being played  .
     * @param query
     * @param requester
     */
    static buildUnresolved(query: string | UnresolvedQuery, requester?: unknown): UnresolvedPlayerTrack {
        if (typeof query === 'undefined') throw new RangeError('Argument "query" must be present.')

        let unresolvedTrack: Partial<UnresolvedPlayerTrack> = {
            requester,
            async resolve(): Promise<void> {
                const resolved = await TrackUtils.getClosestTrack(this)
                Object.getOwnPropertyNames(this).forEach(prop => delete this[prop])
                Object.assign(this, resolved)
            }
        }

        if (typeof query === 'string') unresolvedTrack.title = query
        else unresolvedTrack = { ...unresolvedTrack, ...query }

        Object.defineProperty(unresolvedTrack, UNRESOLVED_TRACK_SYMBOL, {
            configurable: true,
            value: true
        })

        return unresolvedTrack as UnresolvedPlayerTrack
    }

    static async getClosestTrack(unresolvedTrack: UnresolvedPlayerTrack): Promise<PlayerTrack> {
        if (!TrackUtils.manager) throw new RangeError('Manager has not been initiated.')

        if (!TrackUtils.isUnresolvedTrack(unresolvedTrack))
            throw new RangeError('Provided track is not a UnresolvedTrack.')

        const query = [unresolvedTrack.author, unresolvedTrack.title].filter(str => !!str).join(' - ')
        const res = await TrackUtils.manager.search(query, unresolvedTrack.requester)

        if (res.loadType !== 'search')
            throw (
                res.exception ?? {
                    message: 'No tracks found.',
                    severity: 'common'
                }
            )

        if (unresolvedTrack.author) {
            const channelNames = [unresolvedTrack.author, `${unresolvedTrack.author} - Topic`]

            const originalAudio = res.tracks.find(track => {
                return (
                    channelNames.some(name => new RegExp(`^${escapeRegExp(name)}$`, 'i').test(track.author)) ||
                    new RegExp(`^${escapeRegExp(unresolvedTrack.title)}$`, 'i').test(track.title)
                )
            })

            if (originalAudio) return originalAudio
        }

        if (unresolvedTrack.duration) {
            const sameDuration = res.tracks.find(
                track =>
                    track.duration >= unresolvedTrack.duration - 1500 &&
                    track.duration <= unresolvedTrack.duration + 1500
            )

            if (sameDuration) return sameDuration
        }

        return res.tracks[0]
    }
}

export interface UnresolvedQuery {
    /** The title of the unresolved track. */
    title: string
    /** The author of the unresolved track. If provided it will have a more precise search. */
    author?: string
    /** The duration of the unresolved track. If provided it will have a more precise search. */
    duration?: number
}
