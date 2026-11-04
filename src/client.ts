import { LineBuffer } from './protocol.js'

/** The router answers within milliseconds, so this much silence means the connection has gone */
export const REPLY_TIMEOUT_MS = 3000

interface Request {
	command: string
	resolve: (lines: string[] | undefined) => void
}

/**
 * Sends one command at a time and matches each reply to it by id. A reply is a block: `{0001`, its
 * lines, then `}`. Anything outside a block, such as a change message, goes to `onLine`.
 */
export class Lw3Client {
	readonly #write: (data: string) => boolean
	readonly #onLine: (line: string) => void
	readonly #onTimeout: (command: string) => void
	readonly #lines = new LineBuffer()
	#urgent: Request[] = []
	#queue: Request[] = []
	#inFlight: (Request & { id: string }) | undefined
	#block: string[] | undefined
	#timer: ReturnType<typeof setTimeout> | undefined
	#nextId = 1

	constructor(write: (data: string) => boolean, onLine: (line: string) => void, onTimeout: (command: string) => void) {
		this.#write = write
		this.#onLine = onLine
		this.#onTimeout = onTimeout
	}

	get idle(): boolean {
		return this.#inFlight === undefined && this.#urgent.length === 0 && this.#queue.length === 0
	}

	/** Resolves with the reply's lines, or undefined if the connection went first. Urgent ones go ahead of reads. */
	async request(command: string, urgent = false): Promise<string[] | undefined> {
		return new Promise((resolve) => {
			;(urgent ? this.#urgent : this.#queue).push({ command, resolve })
			this.#next()
		})
	}

	push(data: Buffer | string): void {
		for (const line of this.#lines.push(data)) this.#handleLine(line)
	}

	/** Give up on everything, when the connection is lost */
	reset(): void {
		this.#stopTimer()
		this.#lines.reset()
		this.#block = undefined
		const waiting = [...(this.#inFlight ? [this.#inFlight] : []), ...this.#urgent, ...this.#queue]
		this.#inFlight = undefined
		this.#urgent = []
		this.#queue = []
		for (const request of waiting) request.resolve(undefined)
	}

	#handleLine(line: string): void {
		const inFlight = this.#inFlight
		if (line.startsWith('CHG ')) {
			this.#onLine(line)
		} else if (this.#block) {
			if (line !== '}') {
				this.#block.push(line)
			} else {
				const lines = this.#block
				this.#block = undefined
				if (inFlight) this.#finish(inFlight, lines)
			}
		} else if (inFlight && line === `{${inFlight.id}`) {
			this.#block = []
		} else if (line.trim() !== '') {
			this.#onLine(line)
		}
	}

	#finish(request: Request, lines: string[]): void {
		this.#stopTimer()
		this.#inFlight = undefined
		request.resolve(lines)
		this.#next()
	}

	#next(): void {
		if (this.#inFlight) return
		const request = this.#urgent.shift() ?? this.#queue.shift()
		if (!request) return
		const id = String(this.#nextId).padStart(4, '0')
		this.#nextId = this.#nextId >= 9999 ? 1 : this.#nextId + 1
		this.#inFlight = { ...request, id }
		this.#timer = setTimeout(() => this.#onTimeout(request.command), REPLY_TIMEOUT_MS)
		if (!this.#write(`${id}#${request.command}\r\n`)) this.reset()
	}

	#stopTimer(): void {
		if (this.#timer) clearTimeout(this.#timer)
		this.#timer = undefined
	}
}
