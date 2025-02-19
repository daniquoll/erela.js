import { PlayerTrack, UnresolvedPlayerTrack } from './Player'
import { TrackUtils } from './Utils'

/**
 * The player's queue, the `current` property is the currently playing track, think of the rest as the up-coming tracks.
 * @noInheritDoc
 */
export class Queue extends Array<PlayerTrack | UnresolvedPlayerTrack> {
    /** The total duration of the queue. */
    public get duration(): number {
        const current = this.current?.duration ?? 0

        return this.reduce((acc: number, cur: PlayerTrack) => acc + (cur.duration || 0), current)
    }

    /** The total size of tracks in the queue including the current track. */
    public get totalSize(): number {
        return this.length + (this.current ? 1 : 0)
    }

    /** The size of tracks in the queue. */
    public get size(): number {
        return this.length
    }

    /** The current track */
    public current: PlayerTrack | UnresolvedPlayerTrack | null = null

    /** The previous track */
    public previous: PlayerTrack | UnresolvedPlayerTrack | null = null

    /**
     * Adds a track to the queue.
     * @param track
     * @param [offset=null]
     */
    public add(
        track: (PlayerTrack | UnresolvedPlayerTrack) | (PlayerTrack | UnresolvedPlayerTrack)[],
        offset?: number
    ): Queue {
        if (!TrackUtils.validate(track)) {
            throw new RangeError('Track must be a "Track" or "Track[]".')
        }

        if (!this.current) {
            if (Array.isArray(track)) {
                this.current = (track = [...track]).shift()
            } else {
                this.current = track

                return this
            }
        }

        if (typeof offset !== 'undefined' && typeof offset === 'number') {
            if (isNaN(offset)) {
                throw new RangeError('Offset must be a number.')
            }

            if (offset < 0 || offset > this.length) {
                throw new RangeError(`Offset must be or between 0 and ${this.length}.`)
            }
        }

        if (typeof offset === 'undefined' && typeof offset !== 'number') {
            if (track instanceof Array) this.push(...track)
            else this.push(track)
        } else {
            if (track instanceof Array) this.splice(offset, 0, ...track)
            else this.splice(offset, 0, track)
        }

        return this
    }

    /**
     * Removes a track from the queue. Defaults to the first track, returning the removed track, EXCLUDING THE `current` TRACK.
     * @param [position=0]
     */
    public remove(position?: number): PlayerTrack[]

    /**
     * Removes an amount of tracks using a exclusive start and end exclusive index, returning the removed tracks, EXCLUDING THE `current` TRACK.
     * @param start
     * @param end
     */
    public remove(start: number, end: number): (PlayerTrack | UnresolvedPlayerTrack)[]
    public remove(startOrPosition = 0, end?: number): (PlayerTrack | UnresolvedPlayerTrack)[] {
        if (typeof end !== 'undefined') {
            if (isNaN(Number(startOrPosition))) {
                throw new RangeError(`Missing "start" parameter.`)
            } else if (isNaN(Number(end))) {
                throw new RangeError(`Missing "end" parameter.`)
            } else if (startOrPosition >= end) {
                throw new RangeError('Start can not be bigger than end.')
            } else if (startOrPosition >= this.length) {
                throw new RangeError(`Start can not be bigger than ${this.length}.`)
            }

            return this.splice(startOrPosition, end - startOrPosition)
        }

        return this.splice(startOrPosition, 1)
    }

    /** Clears the queue. */
    public clear(): void {
        this.splice(0)
    }

    /** Shuffles the queue. */
    public shuffle(): void {
        for (let i = this.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[this[i], this[j]] = [this[j], this[i]]
        }
    }

    /** Unshuffles the queue. */
    public unshuffle(): void {
        this.sort((a, b) => {
            if (a.buildedAt === b.buildedAt) return (a.identifier || a.title).localeCompare(b.identifier || b.title)
            return a.buildedAt - b.buildedAt
        })
    }
}
