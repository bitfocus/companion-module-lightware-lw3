#!/usr/bin/env node
/**
 * A short, fixed test of what only a real router can answer. Unlike lw3-capture, THIS CHANGES THE ROUTER,
 * but only two outputs with no display on them. It looks for the unroute command, tests locking and
 * salvos, tries some names, then puts things back and reports exactly where it left them.
 *
 *   node tools/lw3-try.mjs ROUTER_IP
 *
 * Defaults: outputs O7 and O8, inputs I2 and I3. Override with --output 7 --second 8 --input 2 --other 3.
 * The log is saved as it goes, so stopping it during the final listening period loses nothing.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lw3Reader, redact } from './lw3-capture.mjs'

const XP = '/MEDIA/XP/VIDEO'
const LISTEN_SECONDS = 60

/** Everything this script may send. Preset, EDID, factory and reset commands can't pass this. */
const ALLOWED =
	/^(?:(?:GET|OPEN) \/[^\r\n]*|CALL \/MEDIA\/XP\/VIDEO:(?:switch|switchMulti|connect|lockDestination|unlockDestination)\([^\r\n]*\)|CALL \/MEDIA\/XP:MultiLayer_(?:Switch|Connect)\([^\r\n]*\)|SET \/MEDIA\/NAMES\/VIDEO\.O\d+=[^\r\n]*)$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const option = (flag, fallback) => {
	const index = process.argv.indexOf(flag)
	return index === -1 ? fallback : Number(process.argv[index + 1])
}

const host = process.argv[2]
const output = option('--output', 7)
const second = option('--second', 8)
const input = option('--input', 2)
const other = option('--other', 3)
const numbers = [output, second, input, other]
if (!host || host.startsWith('--') || !numbers.every((n) => Number.isInteger(n) && n > 0) || output === second) {
	console.error('Usage: node tools/lw3-try.mjs ROUTER_IP [--output 7] [--second 8] [--input 2] [--other 3]')
	process.exit(2)
}
const [O, O2, I, I2] = [`O${output}`, `O${second}`, `I${input}`, `I${other}`]

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures')
mkdirSync(directory, { recursive: true })
const file = join(directory, 'try-latest.txt')
writeFileSync(file, '')

const reader = new Lw3Reader(ALLOWED)
const started = Date.now()
const note = (line) => {
	const stamped = `${String(Date.now() - started).padStart(6)} ms  ${redact(line)}`
	appendFileSync(file, `${stamped}\n`)
	console.log(stamped)
}
reader.onUnsolicited = (line) => note(`<<< ${line}`)

const send = async (command) => {
	note(`>>> ${command}`)
	await sleep(50)
	const lines = await reader.request(command)
	if (lines === undefined) note('!!! no reply')
	for (const line of lines ?? []) note(`    ${line}`)
	return lines ?? []
}
const heading = (text) => note(`--- ${text}`)
const valueOf = (lines) => /=(.*)$/.exec(lines[0] ?? '')?.[1]
const entry = (list, port) => list?.split(';')[port - 1]
const route = (source, destination) => send(`CALL ${XP}:switch(${source}:${destination})`)

/** The source on each of the two outputs, and the status of the first */
const read = async () => {
	const routes = valueOf(await send(`GET ${XP}.DestinationConnectionStatus`))
	const status = valueOf(await send(`GET ${XP}.DestinationPortStatus`))
	return {
		first: entry(routes, output),
		second: entry(routes, second),
		firstStatus: entry(status, output),
		secondStatus: entry(status, second),
	}
}

try {
	await reader.connect(host, 6107)
} catch (error) {
	console.error(`Couldn't connect: ${error.message}`)
	process.exit(1)
}

heading(`Checking ${O} and ${O2} have no display and aren't locked or muted`)
const before = await read()
const displayOnFirst = valueOf(await send(`GET /MEDIA/PORTS/VIDEO/${O}/STATUS.Connected`))
const displayOnSecond = valueOf(await send(`GET /MEDIA/PORTS/VIDEO/${O2}/STATUS.Connected`))
const originalName = valueOf(await send(`GET /MEDIA/NAMES/VIDEO.${O}`))

const problems = []
if (displayOnFirst !== 'false') problems.push(`${O} may have a display (Connected=${displayOnFirst})`)
if (displayOnSecond !== 'false') problems.push(`${O2} may have a display (Connected=${displayOnSecond})`)
if (!before.firstStatus?.startsWith('T')) problems.push(`${O} is locked or muted (${before.firstStatus})`)
if (!before.secondStatus?.startsWith('T')) problems.push(`${O2} is locked or muted (${before.secondStatus})`)
if (before.first === undefined) problems.push(`${O} couldn't be read`)
if (!/^I\d+$/.test(before.second ?? '')) problems.push(`${O2} must be routed so it can be put back (${before.second})`)
if (originalName === undefined) problems.push(`the name of ${O} couldn't be read`)
if (problems.length > 0) {
	console.error(`Nothing was changed. ${problems.join('; ')}.`)
	reader.close()
	process.exit(1)
}

let unrouteWith
try {
	heading('Subscribing')
	for (const node of [XP, '/MEDIA/NAMES/VIDEO', '/MEDIA/PORTS/VIDEO/I1/STATUS', '/MEDIA/PORTS/VIDEO/O1/STATUS']) {
		await send(`OPEN ${node}`)
	}

	heading(`Routing ${I} to ${O} so there is a route to remove`)
	await route(I, O)
	await read()

	heading('Looking for the unroute command, stopping at the first that works')
	for (const form of [
		`CALL ${XP}:switch(0:${O})`,
		`CALL ${XP}:connect(-${I}:${O})`,
		`CALL /MEDIA/XP:MultiLayer_Connect(VIDEO;-${I}:${O})`,
		`CALL /MEDIA/XP:MultiLayer_Switch(VIDEO;0:${O})`,
	]) {
		await send(form)
		if ((await read()).first === '0') {
			unrouteWith = form
			note(`UNROUTE FOUND: ${form}`)
			break
		}
	}
	if (!unrouteWith) note('UNROUTE NOT FOUND')

	heading('Same route twice: is the second an error?')
	await route(I, O)
	await route(I, O)
	await read()

	heading('Lock, then switch the locked output')
	await send(`CALL ${XP}:lockDestination(${O})`)
	await read()
	await route(I2, O)
	await read()
	await send(`CALL ${XP}:unlockDestination(${O})`)
	await read()

	heading('Two routes in one command')
	for (const form of [
		`CALL ${XP}:switch(${I2}:${O};${I2}:${O2})`,
		`CALL ${XP}:switchMulti(${I}:${O};${I}:${O2})`,
		`CALL ${XP}:switchMulti(${I2}:${O};${I2}:${O2};)`,
	]) {
		await route(I, O)
		await route(I, O2)
		await send(form)
		await read()
	}

	heading('Names: the number before the name, and how long a name can be')
	for (const value of ['1;Companion test', '3;Companion test', `2;${'X'.repeat(32)}`, `2;${'X'.repeat(64)}`]) {
		await send(`SET /MEDIA/NAMES/VIDEO.${O}=${value}`)
		await send(`GET /MEDIA/NAMES/VIDEO.${O}`)
	}
} finally {
	heading('Putting everything back')
	const locked = (await read()).firstStatus
	if (locked?.startsWith('L')) await send(`CALL ${XP}:unlockDestination(${O})`)
	await route(before.second, O2)
	if (unrouteWith) {
		await route(I, O)
		await send(unrouteWith)
	} else {
		await route(I, O)
	}
	await send(`SET /MEDIA/NAMES/VIDEO.${O}=${originalName}`)
	const nameAfter = valueOf(await send(`GET /MEDIA/NAMES/VIDEO.${O}`))
	const after = await read()
	const firstGood = unrouteWith ? after.first === '0' : after.first === I
	const clean =
		firstGood && after.second === before.second && after.firstStatus?.startsWith('T') && nameAfter === originalName
	note(
		clean
			? `LEFT AS PLANNED: ${O} is ${unrouteWith ? 'unrouted' : `still on ${I}, as no unroute command was found`}, ${O2} on ${after.second}, name restored`
			: `NOT AS PLANNED: ${O} on ${after.first} (${after.firstStatus}), ${O2} on ${after.second}, name "${nameAfter}", expected name "${originalName}"`,
	)
}

heading(`Listening for ${LISTEN_SECONDS} seconds. Sending nothing.`)
console.log(
	'Now, in this order: 1) change a route from the front panel or web UI, 2) unplug and replug the O1 display,',
)
console.log('3) unplug and replug the I1 source. Wait for "Finished" before pressing anything.')
await sleep(LISTEN_SECONDS * 1000)
reader.close()
note('Finished')
console.log(`Saved to ${file}`)
