/**
 * The LW3 protocol as measured on an MX2-8x8-HDMI20-L, firmware 1.10.1b4. Where the router's own manual
 * text and its behaviour disagree, this follows the behaviour: the manual gives `switch(I1,O1)` for
 * example, which the router rejects with a syntax error.
 */

export const DEFAULT_PORT = 6107

const XP = '/MEDIA/XP/VIDEO'
const NAMES = '/MEDIA/NAMES/VIDEO'
const PRESETS = '/MEDIA/PRESET'

/** Longest name the router stores: it keeps the first 62 characters of anything longer */
export const MAX_NAME_LENGTH = 62

/** Paths are built from preset names, so a name that could change the command never reaches the router */
const SAFE_PRESET_NAME = /^[A-Za-z0-9_-]+$/

export const isSafePresetName = (name: string): boolean => SAFE_PRESET_NAME.test(name)

export type PortId = `I${number}` | `O${number}`

/** A route: the input to send to the output, with input 0 meaning no input */
export interface Route {
	input: number
	output: number
}

const routeText = ({ input, output }: Route): string => `${input === 0 ? '0' : `I${input}`}:O${output}`

export const Cmd = {
	productName: 'GET /.ProductName',
	firmware: 'GET /MANAGEMENT/UID.FirmwareVersion',
	subscribeRouting: `OPEN ${XP}`,
	subscribeNames: `OPEN ${NAMES}`,
	/** The `*` includes the nodes below, which is where each preset is. What it announces hasn't been measured. */
	subscribePresets: `OPEN ${PRESETS}/*`,
	routes: `GET ${XP}.DestinationConnectionStatus`,
	/** Some models and firmwares may only have this older name. Not seen on a real router yet. */
	routesOlder: `GET ${XP}.DestinationConnectionList`,
	destinationStatus: `GET ${XP}.DestinationPortStatus`,
	sourceStatus: `GET ${XP}.SourcePortStatus`,
	names: `GET ${NAMES}.*`,
	presets: `GET ${PRESETS}`,
	softReset: 'CALL /SYS:softReset()',
	presetRoutes: (name: string): string => `GET ${PRESETS}/${name}.VideoDestination`,
	loadPreset: (name: string): string => `CALL ${PRESETS}/${name}:load()`,
	/** Several routes in one command change together, in a single change message */
	switch: (routes: Route[]): string => `CALL ${XP}:switch(${routes.map(routeText).join(';')})`,
	lock: (output: number): string => `CALL ${XP}:lockDestination(O${output})`,
	unlock: (output: number): string => `CALL ${XP}:unlockDestination(O${output})`,
	rename: (port: PortId, prefix: string, name: string): string => `SET ${NAMES}.${port}=${prefix};${name}`,
}

/** Router error codes that have been seen, with what they turned out to mean */
export const ErrorCode = {
	syntax: 'E001',
	/** Also what the router says when there is nothing to do, such as unlocking an unlocked output */
	notExists: 'E002',
	invalidValue: 'E004',
	/** A switch to a locked output */
	accessDenied: 'E007',
} as const

/** Splits a byte stream into the router's CRLF terminated lines */
export class LineBuffer {
	#buffer = ''

	push(data: Buffer | string): string[] {
		this.#buffer += typeof data === 'string' ? data : data.toString('latin1')
		const lines = this.#buffer.split('\r\n')
		this.#buffer = lines.pop() ?? ''
		return lines
	}

	reset(): void {
		this.#buffer = ''
	}
}

export interface Property {
	path: string
	property: string
	value: string
}

/** `pr /A/B.Name=1`, `pw /A/B.Name=1` or `CHG /A/B.Name=1` */
export function parseProperty(line: string): Property | undefined {
	const match = /^(?:pr|pw|CHG)\s+(\S*?)\.([A-Za-z0-9_]+)=(.*)$/.exec(line)
	return match ? { path: match[1], property: match[2], value: match[3] } : undefined
}

export interface RouterError {
	code: string
	message: string
}

/** `mE /A:b %E007: Access denied`, and the same with pE or nE */
export function parseError(line: string): RouterError | undefined {
	const match = /^[mpn]E\s+\S+\s+%(E\d+):?\s*(.*)$/.exec(line)
	return match ? { code: match[1], message: match[2] } : undefined
}

/** The first error in a reply */
export const replyError = (lines: string[]): RouterError | undefined => {
	for (const line of lines) {
		const error = parseError(line)
		if (error) return error
	}
	return undefined
}

/** `I1;I2;0;` to its entries, without the empty one after the last `;` */
export function parseList(value: string): string[] {
	const entries = value.split(';')
	if (entries[entries.length - 1] === '') entries.pop()
	return entries
}

/** `I3` to 3 and `0` to 0, which means nothing is routed */
export function parseSource(entry: string): number | undefined {
	if (entry === '0') return 0
	const match = /^I(\d+)$/.exec(entry)
	return match ? Number(match[1]) : undefined
}

/** A preset's `uI1`: the leading letter is the port's state, then the source */
export function parsePresetSource(entry: string): number | undefined {
	const match = /^[A-Za-z]?(I\d+|0)$/.exec(entry)
	return match ? parseSource(match[1]) : undefined
}

export interface PortStatus {
	locked: boolean
	muted: boolean
	/** A cable with +5V: on an output, a display */
	connected: boolean
	signal: boolean
}

/**
 * `TFF` is a letter and two hex digits. T is free, L locked, M muted and U (from Lightware's whitepaper,
 * not seen yet) both. In the last digit, bit 0 is the connection and bit 2 the signal, worked out from
 * these values while pulling cables: A neither, B connected only, E signal only, F both.
 */
export function parsePortStatus(entry: string): PortStatus | undefined {
	const match = /^([TLMU])[0-9A-Fa-f]([0-9A-Fa-f])$/.exec(entry)
	if (!match) return undefined
	const bits = parseInt(match[2], 16)
	return {
		locked: match[1] === 'L' || match[1] === 'U',
		muted: match[1] === 'M' || match[1] === 'U',
		connected: (bits & 0b0001) !== 0,
		signal: (bits & 0b0100) !== 0,
	}
}

export interface PortName {
	port: PortId
	/** A number the router requires and stores but gives no meaning for. Sent back unchanged when renaming. */
	prefix: string
	name: string
}

/** The value of `/MEDIA/NAMES/VIDEO.I1`, such as `2;Input 1` */
export function parsePortName(port: string, value: string): PortName | undefined {
	const portMatch = /^[IO]\d+$/.exec(port)
	const separator = value.indexOf(';')
	if (!portMatch || separator === -1) return undefined
	return { port: port as PortId, prefix: value.slice(0, separator), name: value.slice(separator + 1) }
}

/** What to send for a name: no control characters, as they would end the command */
export function cleanName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\x00-\x1f\x7f]/g, '').trim()
}

/** Child nodes from the reply to `GET /MEDIA/PRESET`, which are `n- /MEDIA/PRESET/NAME` */
export function parsePresetNames(lines: string[]): string[] {
	const names: string[] = []
	for (const line of lines) {
		const match = /^n-\s+\/MEDIA\/PRESET\/(\S+)$/.exec(line)
		if (match) names.push(match[1])
	}
	return names
}
