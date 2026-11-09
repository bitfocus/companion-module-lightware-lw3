import type { CompanionHTTPRequest, CompanionHTTPResponse } from '@companion-module/base'
import { MAX_NAME_LENGTH, MAX_ROUTER_NAME_LENGTH, NAME_SUBSTITUTES, isValidName } from './protocol.js'

export interface EdidSlot {
	id: string
	name: string
	resolution: string
	valid: boolean
}

export interface InputRow {
	port: number
	name: string
	edid: string
	hdcp: string
	signal: boolean
}

export interface OutputRow {
	port: number
	name: string
	hdcp: string
}

export interface PortsSnapshot {
	routerName: string
	standby: boolean
	inputs: InputRow[]
	outputs: OutputRow[]
	edids: EdidSlot[]
}

export interface PortChanges {
	routerName?: string
	names: { port: string; name: string }[]
	inputHdcp: { port: number; value: string }[]
	outputHdcp: { port: number; value: string }[]
	edids: { port: number; slot: string }[]
}

/** What went wrong, by `I1 name`, `O3 hdcp` or `I2 edid` */
export type ChangeErrors = Record<string, string>

export interface PortsHost {
	readonly connected: boolean
	/** Where a browser can reach the router's own WebSocket, as `host:port` */
	readonly routerAddress: string
	readPorts(): Promise<PortsSnapshot | undefined>
	readEdids(): Promise<EdidSlot[] | undefined>
	applyPorts(changes: PortChanges): Promise<ChangeErrors>
	storeEdid(from: string, to: string): Promise<string | undefined>
	deleteEdid(slot: string): Promise<string | undefined>
	/** Returns why it didn't happen, if it didn't */
	hotplug(port: string): Promise<string | undefined>
	/** Names of the outputs an input feeds, which a hotplug on it drops too */
	outputsFedBy(input: number): string[]
	/** As the module knows them, which follows the router's announcements */
	presets(): PresetRow[]
	savePreset(name: string): Promise<string | undefined>
	createPreset(name: string): Promise<string | undefined>
	copyPreset(from: string, to: string, rename: boolean): Promise<string | undefined>
	deletePreset(name: string): Promise<string | undefined>
}

export interface PresetRow {
	name: string
	/** The input for each output, 0 for none */
	routes: (number | undefined)[]
	live: boolean
	/** The front-panel preset buttons it is on */
	slots: number[]
}

export const INPUT_HDCP = ['0', '2', '3']
export const OUTPUT_HDCP = ['AUTO', 'ALWAYS']

const json = (status: number, body: unknown): CompanionHTTPResponse => ({
	status,
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body),
})

/** Companion answers cross-origin requests, so a web page elsewhere must not be able to change the router */
function fromAnotherSite(request: CompanionHTTPRequest): boolean {
	const { origin, host } = request.headers
	if (!origin) return false
	try {
		return new URL(origin).host !== host
	} catch {
		return true
	}
}

function parseBody(request: CompanionHTTPRequest): Record<string, unknown> | undefined {
	// typed as a string, but Companion has already parsed a body sent as JSON
	const body: unknown = request.body
	try {
		const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : body
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
	} catch {
		return undefined
	}
}

/** All or nothing: returns why these changes can't be sent, so a mistake can't leave the router half changed */
export function checkChanges(changes: PortChanges, snapshot: PortsSnapshot): string | undefined {
	const inputs = new Set(snapshot.inputs.map((row) => row.port))
	const outputs = new Set(snapshot.outputs.map((row) => row.port))
	const usable = new Set(snapshot.edids.filter((slot) => slot.valid).map((slot) => slot.id))

	if (changes.routerName !== undefined) {
		if (changes.routerName === '') return 'The router needs a name'
		if (changes.routerName.length > MAX_ROUTER_NAME_LENGTH)
			return `The router name can be ${MAX_ROUTER_NAME_LENGTH} characters at most`
		if (!isValidName(changes.routerName)) return 'The router name can only have plain characters'
	}
	for (const { port, name } of changes.names) {
		const match = /^([IO])(\d+)$/.exec(port)
		const known = match && (match[1] === 'I' ? inputs : outputs).has(Number(match[2]))
		if (!known) return `No such port: ${port}`
		if (name === '') return `${port} needs a name`
		if (name.length > MAX_NAME_LENGTH) return `${port}: the router keeps ${MAX_NAME_LENGTH} characters at most`
		if (!isValidName(name)) return `${port}: the router only stores plain characters, not accents or emoji`
	}
	for (const { port, value } of changes.inputHdcp) {
		if (!inputs.has(port)) return `No such port: I${port}`
		if (!INPUT_HDCP.includes(value)) return `I${port}: unknown HDCP setting ${value}`
	}
	for (const { port, value } of changes.outputHdcp) {
		if (!outputs.has(port)) return `No such port: O${port}`
		if (!OUTPUT_HDCP.includes(value)) return `O${port}: unknown HDCP setting ${value}`
	}
	for (const { port, slot } of changes.edids) {
		if (!inputs.has(port)) return `No such port: I${port}`
		// the router would accept an empty slot, leaving the input with no EDID
		if (!usable.has(slot)) return `I${port}: ${slot} holds no EDID`
	}
	return undefined
}

function readChanges(body: Record<string, unknown>): PortChanges | undefined {
	const { routerName, names, inputHdcp, outputHdcp, edids } = body
	const lists = [names, inputHdcp, outputHdcp, edids]
	if (!lists.every(Array.isArray)) return undefined
	const texts = (names as { port?: unknown; name?: unknown }[]).map(({ port, name }) => ({
		port: String(port),
		name: typeof name === 'string' ? name.trim() : '',
	}))
	const settings = (list: unknown): { port: number; value: string }[] =>
		(list as { port?: unknown; value?: unknown }[]).map(({ port, value }) => ({
			port: Number(port),
			value: String(value),
		}))
	return {
		...(routerName === undefined ? {} : { routerName: typeof routerName === 'string' ? routerName.trim() : '' }),
		names: texts,
		inputHdcp: settings(inputHdcp),
		outputHdcp: settings(outputHdcp),
		edids: (edids as { port?: unknown; slot?: unknown }[]).map(({ port, slot }) => ({
			port: Number(port),
			slot: String(slot),
		})),
	}
}

async function applyChanges(host: PortsHost, request: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
	const body = parseBody(request)
	const changes = body && readChanges(body)
	if (!changes) return json(400, { error: 'The request is not a list of changes' })
	const snapshot = await host.readPorts()
	if (!snapshot) return json(503, { error: 'Not connected to the router' })
	const problem = checkChanges(changes, snapshot)
	if (problem) return json(400, { error: problem })
	const errors = await host.applyPorts(changes)
	return json(200, { errors, snapshot: await host.readPorts() })
}

async function store(host: PortsHost, request: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
	const { from, to } = parseBody(request) ?? {}
	if (typeof from !== 'string' || typeof to !== 'string') return json(400, { error: 'The request needs from and to' })
	if (!/^U\d+$/.test(to)) return json(400, { error: 'An EDID can only be stored in a U slot' })
	const snapshot = await host.readPorts()
	if (!snapshot) return json(503, { error: 'Not connected to the router' })
	if (!snapshot.edids.some((slot) => slot.id === from && slot.valid))
		return json(400, { error: `${from} holds no EDID` })
	if (!snapshot.edids.some((slot) => slot.id === to)) return json(400, { error: `No such slot: ${to}` })
	const error = await host.storeEdid(from, to)
	return error ? json(502, { error }) : json(200, { snapshot: await host.readPorts() })
}

async function remove(host: PortsHost, request: CompanionHTTPRequest): Promise<CompanionHTTPResponse> {
	const { slot } = parseBody(request) ?? {}
	if (typeof slot !== 'string' || !/^U\d+$/.test(slot)) return json(400, { error: 'Only a U slot can be deleted' })
	const error = await host.deleteEdid(slot)
	return error ? json(502, { error }) : json(200, { snapshot: await host.readPorts() })
}

async function presetAction(
	host: PortsHost,
	action: string,
	request: CompanionHTTPRequest,
): Promise<CompanionHTTPResponse> {
	const { name, to } = parseBody(request) ?? {}
	if (typeof name !== 'string') return json(400, { error: 'The request needs a name' })
	let error: string | undefined
	if (action === 'save') error = await host.savePreset(name)
	else if (action === 'create') error = await host.createPreset(name)
	else if (action === 'delete') error = await host.deletePreset(name)
	else if (action === 'copy' || action === 'rename') {
		if (typeof to !== 'string') return json(400, { error: 'The request needs a new name' })
		error = await host.copyPreset(name, to, action === 'rename')
	} else return json(404, { error: 'No such preset action' })
	return error ? json(502, { error }) : json(200, { presets: host.presets() })
}

/** The table of ports, served by Companion at /instance/<connection label>/ */
export async function handlePortsRequest(
	host: PortsHost,
	request: CompanionHTTPRequest,
): Promise<CompanionHTTPResponse> {
	const path = request.path.replace(/\/+$/, '')
	if (path === '' && request.method === 'GET') {
		return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE }
	}
	if (path === '/ports' && request.method === 'GET') {
		const snapshot = await host.readPorts()
		return snapshot
			? json(200, { ...snapshot, router: host.routerAddress })
			: json(503, { error: 'Not connected to the router' })
	}
	if (path === '/presets' && request.method === 'GET') return json(200, { presets: host.presets() })
	if (path === '/feeds' && request.method === 'GET') {
		const input = Number(request.query.input)
		if (!Number.isInteger(input) || input < 1) return json(400, { error: 'The request needs an input number' })
		return json(200, { outputs: host.outputsFedBy(input) })
	}
	if (path === '/edids' && request.method === 'GET') {
		const edids = await host.readEdids()
		return edids ? json(200, { edids }) : json(503, { error: 'Not connected to the router' })
	}
	if (request.method === 'POST' && fromAnotherSite(request)) {
		return json(403, { error: 'Requests from another site are not allowed' })
	}
	if (request.method === 'POST' && !host.connected) return json(503, { error: 'Not connected to the router' })
	if (path === '/ports' && request.method === 'POST') return applyChanges(host, request)
	if (path === '/edid/store' && request.method === 'POST') return store(host, request)
	if (path === '/edid/delete' && request.method === 'POST') return remove(host, request)
	if (path.startsWith('/preset/') && request.method === 'POST') return presetAction(host, path.slice(8), request)
	if (path === '/hotplug' && request.method === 'POST') {
		const { port } = parseBody(request) ?? {}
		if (typeof port !== 'string' || !/^[IO]\d+$/.test(port)) return json(400, { error: 'The request needs a port' })
		const error = await host.hotplug(port)
		return error ? json(502, { error }) : json(200, {})
	}
	return json(404, { error: 'Not found' })
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lightware ports</title>
<style>
:root { color-scheme: light dark; --line: #8884; --changed: #ff800033; --bad: #d33; --good: #2a8a3a; --dynamic: #ff800066; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: Canvas; color: CanvasText; }
header { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 16px; background: Canvas; border-bottom: 1px solid var(--line); }
h1 { font-size: 16px; margin: 0 auto 0 0; }
h2 { font-size: 15px; margin: 16px 0 6px; }
button { font: inherit; padding: 4px 12px; }
#message { width: 100%; }
#message:empty { display: none; }
.problem { color: var(--bad); }
.saved { color: var(--good); }
main { padding: 0 16px 24px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 620px; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); }
th.port { width: 3.5em; font-weight: 500; }
th:nth-child(2) { width: 28%; }
td.status { width: 22%; }
td.buttons { white-space: nowrap; }
details.region > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
details.region > summary::-webkit-details-marker { display: none; }
details.region > summary::before { content: '▸'; display: inline-block; transition: transform 0.15s; }
details.region[open] > summary::before { transform: rotate(90deg); }
details.region > summary h2 { display: inline; margin: 16px 0 8px; }
#presets th.port { white-space: nowrap; }
td.buttons button { margin: 2px; }
input, select { font: inherit; width: 100%; padding: 2px 4px; max-width: 100%; }
tr.changed { background: var(--changed); }
select.dynamic { background: var(--dynamic); }
input.invalid { outline: 2px solid var(--bad); }
.sent-as { color: GrayText; font-size: 12px; }
.sent-as:empty { display: none; }
h1 small { font-size: 12px; font-weight: 500; margin-left: 8px; color: GrayText; }
h1 small.on { color: var(--good); }
#standby { color: var(--bad); }
.router-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; padding: 4px; }
.router-row label { font-weight: 500; }
.router-row input { flex: 1 1 200px; width: auto; max-width: 360px; }
.router-row.changed { background: var(--changed); }
.filter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
.filter input { flex: 1 1 200px; width: auto; max-width: 360px; }
.note { color: GrayText; margin: 4px 0; }
.store { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.store select { width: auto; max-width: 100%; flex: 1 1 240px; }
@media (max-width: 600px) {
	h1 { width: 100%; margin: 0; }
	header button { padding: 4px 8px; }
}
dialog ul { max-height: 50vh; overflow: auto; padding-left: 18px; }
dialog .warn { color: var(--bad); }
#preset-name-input { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; }
#preset-name-problem { min-height: 1.3em; }
</style>
</head>
<body>
<header>
<h1><span id="title">Lightware ports</span><small id="live">Not live</small><small id="standby" hidden>Standby: changes are refused</small></h1>
<button id="apply" disabled>Apply</button>
<button id="reload">Reload</button>
<button id="revert" disabled title="Fill in the values from before the last Apply">Revert last Apply</button>
<button id="copy" title="Copy every port, to paste into a spreadsheet">Copy all</button>
<div id="message"></div>
</header>
<main>
<div id="router-row"></div>
<details class="region" id="region-inputs" open><summary><h2>Inputs</h2></summary>
<div class="filter">
<input id="edid-filter" type="search" placeholder="Filter EDIDs, such as 3840 p60" aria-label="Filter the EDID lists">
<span id="edid-count" class="note"></span>
</div>
<div class="scroll"><table id="inputs"><thead><tr>
<th>Port</th><th>Name</th>
<th>EDID<br><select id="all-edid" aria-label="Set every input's EDID"></select></th>
<th>HDCP<br><select id="all-input-hdcp" aria-label="Set every input's HDCP"></select></th>
<th></th><th></th></tr></thead><tbody></tbody></table></div>
<p class="note">An orange EDID is dynamic: it follows whatever display was last on that output, so it can change by itself.</p>
</details>
<details class="region" id="region-outputs" open><summary><h2>Outputs</h2></summary>
<div class="scroll"><table id="outputs"><thead><tr>
<th>Port</th><th>Name</th>
<th>HDCP<br><select id="all-output-hdcp" aria-label="Set every output's HDCP"></select></th>
<th></th><th></th></tr></thead><tbody></tbody></table></div>
</details>
<details class="region" id="region-presets" open><summary><h2>Router presets</h2></summary>
<div class="scroll"><table id="presets"><thead><tr>
<th>Name</th><th>Routes (output: input)</th><th></th></tr></thead><tbody></tbody></table></div>
<div class="store">
<input id="new-preset" placeholder="New preset name" aria-label="New preset name" maxlength="46">
<button id="create-preset">Create from current routes</button>
</div>
<p class="note">Save and Create store what is routed now, not what is staged. Names can use letters, digits, - and _.</p>
</details>
<details class="region" id="region-edids" open><summary><h2>Stored EDIDs</h2></summary>
<div class="store">
<select id="store-from" aria-label="EDID to store"></select>
<span>into</span>
<select id="store-to" aria-label="Slot to store it in"></select>
<button id="store">Store</button>
</div>
<div class="store" style="margin-top:8px">
<select id="delete-slot" aria-label="Stored EDID to delete"></select>
<button id="delete">Delete</button>
</div>
</details>
<details class="region" id="region-about" open><summary><h2>About this page</h2></summary>
<p class="note">Changes here go to the router straight away, once confirmed.</p>
<p class="note">Hotplug makes a port look unplugged for 2 seconds. On an output it can wake a display that lost its picture. On an input it makes the source read its EDID again, and every output that input feeds drops too.</p>
<p class="note">Live means changes made on the router appear here as they happen. Not live means this browser can't reach the router itself: everything still works, but press Reload to see them. The router never announces stored EDIDs, so they are read again when you click the filter box.</p>
</details>
</main>
<dialog id="preset-name">
<form method="dialog">
<label id="preset-name-title" for="preset-name-input"></label>
<input id="preset-name-input" maxlength="46" autocomplete="off" autocapitalize="off" spellcheck="false">
<p id="preset-name-problem" class="warn" role="alert"></p>
<button id="preset-name-send" value="send">Send to the router</button>
<button id="preset-name-cancel" type="button">Cancel</button>
</form>
</dialog>
<dialog id="confirm">
<p id="confirm-title"></p>
<ul id="confirm-list"></ul>
<p id="confirm-warning" class="warn"></p>
<button id="confirm-send">Send to the router</button>
<button id="confirm-cancel">Cancel</button>
</dialog>
<script>
const base = location.pathname.replace(/\/?$/, '/')
const INPUT_HDCP = [['0', 'Off'], ['2', 'HDCP 2.2'], ['3', 'HDCP 2.2 Strict']]
const OUTPUT_HDCP = [['AUTO', 'Auto'], ['ALWAYS', 'Always']]
const COLUMNS = ['name', 'edid', 'hdcp']
const MAX_NAME = ${MAX_NAME_LENGTH}
const MAX_ROUTER_NAME = ${MAX_ROUTER_NAME_LENGTH}
const SUBSTITUTES = ${JSON.stringify(NAME_SUBSTITUTES)}
function plainName(name) {
	if (/^[\x20-\x7e]*$/.test(name)) return name.trim()
	return [...name.normalize('NFD')].map((character) => SUBSTITUTES[character] ?? character).join('').replace(/[^\x20-\x7e]/g, '').replace(/ {2,}/g, ' ').trim()
}
let snapshot
let rows = []
let lastApplied = new Map()
let routerAddress
let live
let liveBeat
let liveRetry
let missedChanges = false
let applying = false

const $ = (id) => document.getElementById(id)
function say(text, problem) {
	$('message').textContent = text
	$('message').className = problem ? 'problem' : ''
}
const slotLabel = (slot) => {
	if (!slot.valid) return slot.id + ' (empty)'
	return [slot.id, slot.name.trim(), slot.resolution.replace(/\.00Hz$/, '')].filter(Boolean).join('  ')
}
function fillSelect(select, options, value) {
	select.replaceChildren(...options.map(([id, text]) => new Option(text, id)))
	if (value !== undefined) select.value = value
	// what it had may have gone, and a list with nothing chosen looks empty
	if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0
}
const filterTerms = () => $('edid-filter').value.toLowerCase().split(/\s+/).filter(Boolean)
const matchesFilter = (slot, terms) => terms.every((term) => slotLabel(slot).toLowerCase().includes(term))
/** What a list offers. Its current value always stays, so filtering can't change anything by itself. */
const edidOptions = (current) => {
	const terms = filterTerms()
	const usable = snapshot.edids.filter((slot) => slot.id === current || (slot.valid && matchesFilter(slot, terms)))
	return usable.map((slot) => [slot.id, slotLabel(slot)])
}
function setEdid(row, id) {
	if (![...row.edid.options].some((option) => option.value === id)) row.edid.add(new Option(edidLabel(id), id))
	row.edid.value = id
}
function fillEdidLists() {
	for (const row of rows) if (row.edid) fillSelect(row.edid, edidOptions(row.edid.value), row.edid.value)
	fillSelect($('all-edid'), [['', 'Set all...'], ...edidOptions()], '')
	const from = $('store-from').value
	const first = (slot) => (slot.id.startsWith('U') ? 1 : 0)
	const offered = edidOptions(from).map(([id]) => snapshot.edids.find((slot) => slot.id === id))
	fillSelect($('store-from'), offered.sort((a, b) => first(a) - first(b)).map((slot) => [slot.id, slotLabel(slot)]), from || undefined)
	const to = $('store-to').value
	fillSelect($('store-to'), snapshot.edids.filter((slot) => slot.id.startsWith('U')).map((slot) => [slot.id, slotLabel(slot)]), to || undefined)
	const stored = snapshot.edids.filter((slot) => slot.id.startsWith('U') && slot.valid)
	const slot = $('delete-slot').value
	fillSelect($('delete-slot'), stored.map((item) => [item.id, slotLabel(item)]), slot || undefined)
	$('delete').disabled = stored.length === 0
	const terms = filterTerms()
	const valid = snapshot.edids.filter((slot) => slot.valid)
	$('edid-count').textContent = terms.length ? valid.filter((slot) => matchesFilter(slot, terms)).length + ' of ' + valid.length : ''
}
$('edid-filter').addEventListener('input', () => { if (snapshot) fillEdidLists() })
/** The router doesn't announce stored EDIDs changing, so look when someone is about to pick one */
let readingEdids = false
$('edid-filter').addEventListener('focus', async () => {
	if (!snapshot || readingEdids) return
	readingEdids = true
	try {
		const response = await fetch(base + 'edids')
		if (response.ok) {
			snapshot.edids = (await response.json()).edids
			fillEdidLists()
		}
	} catch {
		// the lists keep what they have, and Reload says what's wrong
	} finally {
		readingEdids = false
	}
})

function buildRow(kind, data) {
	const tr = document.createElement('tr')
	const port = kind + data.port
	const th = document.createElement('th')
	th.className = 'port'
	th.textContent = port
	const name = document.createElement('input')
	name.value = data.name
	name.setAttribute('aria-label', 'Name of ' + port)
	const nameCell = document.createElement('td')
	const sentAs = document.createElement('div')
	sentAs.className = 'sent-as'
	nameCell.append(name, sentAs)
	tr.append(th, nameCell)
	const row = { kind, port, number: data.port, tr, name, sentAs, original: { name: data.name, edid: data.edid, hdcp: data.hdcp } }
	if (kind === 'I') {
		row.edid = document.createElement('select')
		row.edid.setAttribute('aria-label', 'EDID of ' + port)
		fillSelect(row.edid, edidOptions(data.edid), data.edid)
		const cell = document.createElement('td')
		cell.append(row.edid)
		tr.append(cell)
		row.signal = data.signal
	}
	row.hdcp = document.createElement('select')
	row.hdcp.setAttribute('aria-label', 'HDCP of ' + port)
	fillSelect(row.hdcp, kind === 'I' ? INPUT_HDCP : OUTPUT_HDCP, data.hdcp)
	const hdcpCell = document.createElement('td')
	hdcpCell.append(row.hdcp)
	const hotplug = document.createElement('button')
	hotplug.textContent = 'Hotplug'
	hotplug.setAttribute('aria-label', 'Hotplug ' + port)
	hotplug.addEventListener('click', () => hotplugPort(row, hotplug))
	const hotplugCell = document.createElement('td')
	hotplugCell.append(hotplug)
	row.status = document.createElement('td')
	row.status.className = 'status'
	tr.append(hdcpCell, hotplugCell, row.status)
	for (const control of [row.name, row.edid, row.hdcp]) {
		if (control) control.addEventListener('input', () => { setStatus(row, ''); refreshRow(row) })
	}
	name.addEventListener('paste', (event) => {
		const text = event.clipboardData.getData('text')
		if (!/[\r\n\t]/.test(text.trim()) && !parseKeyed(text)) return
		event.preventDefault()
		pasteFrom(row, text)
	})
	return row
}

function buildRouterRow(name) {
	const tr = document.createElement('div')
	tr.className = 'router-row'
	const label = document.createElement('label')
	label.textContent = 'Router name'
	label.htmlFor = 'router-name'
	const input = document.createElement('input')
	input.id = 'router-name'
	input.value = name
	const sentAs = document.createElement('span')
	sentAs.className = 'sent-as'
	const status = document.createElement('span')
	status.className = 'status'
	tr.append(label, input, sentAs, status)
	const row = { kind: 'R', port: 'Router', tr, name: input, sentAs, status, max: MAX_ROUTER_NAME, original: { name } }
	input.addEventListener('input', () => { setStatus(row, ''); refreshRow(row) })
	return row
}
function showRouterName(name) {
	const title = (name || 'Lightware') + ' ports'
	$('title').textContent = title
	document.title = title
}
function setStatus(row, text, className) {
	row.status.textContent = text
	row.status.className = 'status ' + (className || '')
}
const nameProblem = (value, original, max = MAX_NAME) => {
	const plain = plainName(value)
	// the router itself allows an empty router name, which shouldn't get in the way of anything else
	if (plain === original) return ''
	if (value.trim() === '') return 'Needs a name'
	if (plain === '') return 'Nothing is left once accents and emoji are removed'
	if (plain.length > max) return 'The router keeps ' + max + ' characters at most'
	return ''
}
function changesOf(row) {
	const found = []
	if (plainName(row.name.value) !== row.original.name) found.push('name')
	if (row.edid && row.edid.value !== row.original.edid) found.push('edid')
	if (row.hdcp && row.hdcp.value !== row.original.hdcp) found.push('hdcp')
	return found
}
function refreshRow(row) {
	row.tr.classList.toggle('changed', changesOf(row).length > 0)
	if (row.kind === 'R') showRouterName(row.original.name)
	const problem = nameProblem(row.name.value.trim(), row.original.name, row.max)
	row.name.classList.toggle('invalid', problem !== '')
	row.name.title = problem
	const typed = row.name.value.trim()
	const plain = plainName(typed)
	row.sentAs.textContent = plain !== typed && plain !== '' ? 'Will be sent as ' + plain : ''
	if (row.edid) row.edid.classList.toggle('dynamic', row.edid.value.startsWith('D'))
	refreshApply()
}
function refreshApply() {
	const changed = rows.some((row) => changesOf(row).length > 0)
	const bad = rows.some((row) => nameProblem(row.name.value.trim(), row.original.name, row.max) !== '')
	$('apply').disabled = !changed || bad
}

function render(data) {
	snapshot = data
	$('standby').hidden = !data.standby
	const previous = new Map(rows.map((row) => [row.port, row.status.textContent + '|' + row.status.className]))
	rows = []
	const routerRow = buildRouterRow(data.routerName)
	rows.push(routerRow)
	$('router-row').replaceChildren(routerRow.tr)
	refreshRow(routerRow)
	const oldStatus = previous.get('Router')
	if (oldStatus) {
		const [text, className] = oldStatus.split('|')
		routerRow.status.textContent = text
		routerRow.status.className = className
	}
	for (const [kind, id, list] of [['I', 'inputs', data.inputs], ['O', 'outputs', data.outputs]]) {
		const body = $(id).querySelector('tbody')
		body.replaceChildren()
		for (const item of list) {
			const row = buildRow(kind, item)
			rows.push(row)
			body.append(row.tr)
			refreshRow(row)
			const old = previous.get(row.port)
			if (old) {
				const [text, className] = old.split('|')
				row.status.textContent = text
				row.status.className = className
			}
		}
	}
	fillSelect($('all-input-hdcp'), [['', 'Set all...'], ...INPUT_HDCP], '')
	fillSelect($('all-output-hdcp'), [['', 'Set all...'], ...OUTPUT_HDCP], '')
	fillEdidLists()
	refreshApply()
}

function setAll(kind, field, value) {
	if (!value) return
	for (const row of rows) {
		if (row.kind !== kind || !row[field]) continue
		row[field].value = value
		setStatus(row, '')
		refreshRow(row)
	}
}
$('all-edid').addEventListener('input', (event) => { setAll('I', 'edid', event.target.value); event.target.value = '' })
$('all-input-hdcp').addEventListener('input', (event) => { setAll('I', 'hdcp', event.target.value); event.target.value = '' })
$('all-output-hdcp').addEventListener('input', (event) => { setAll('O', 'hdcp', event.target.value); event.target.value = '' })

/** "I1<tab>Name<tab>F137<tab>2", as Copy all writes them, or "I1 = Name" */
function parseKeyed(line) {
	const match = /^\s*([IO])0*(\d+)\s*(?:=|\t|,)\s*(.*?)\s*$/i.exec(line)
	if (!match) return undefined
	return { row: rows.find((row) => row.port === match[1].toUpperCase() + match[2]), cells: match[3].split('\t') }
}
/** Blank cells are skipped, and a value the column doesn't have counts as not pasted */
function fillCells(row, cells, firstColumn) {
	let missed = 0
	cells.forEach((cell, offset) => {
		const value = cell.trim()
		const control = row[COLUMNS[firstColumn + offset]]
		if (value === '' || !control) return
		if (control === row.edid) {
			// the filter may be hiding it, so ask the router's list rather than the dropdown
			if (!snapshot.edids.some((slot) => slot.valid && slot.id === value)) {
				missed++
				return
			}
			setEdid(row, value)
			return
		}
		if (control.tagName === 'SELECT' && ![...control.options].some((option) => option.value === value)) {
			missed++
			return
		}
		control.value = value
	})
	setStatus(row, '')
	refreshRow(row)
	return missed
}
/** Keyed lines go to their own port. Plain lines fill down from the cell pasted into, within its table. */
function pasteFrom(start, text) {
	const table = rows.filter((row) => row.kind === start.kind)
	let index = table.indexOf(start)
	let missed = 0
	for (const line of text.replace(/\r/g, '').replace(/\n+$/, '').split('\n')) {
		if (/^\s*port\t/i.test(line)) continue
		const keyed = parseKeyed(line)
		if (keyed) {
			if (keyed.row) missed += fillCells(keyed.row, keyed.cells, 0)
			else missed++
			continue
		}
		const row = table[index++]
		if (row) missed += fillCells(row, line.split('\t'), 0)
		else missed++
	}
	say(missed ? missed + ' pasted value(s) did not match a port or setting and were ignored' : '', missed > 0)
}

function ask(title, lines, warning) {
	$('confirm-title').textContent = title
	$('confirm-list').replaceChildren(...lines.map((line) => {
		const item = document.createElement('li')
		item.textContent = line
		return item
	}))
	$('confirm-warning').textContent = warning || ''
	$('confirm').showModal()
	return new Promise((resolve) => {
		const finish = (answer) => {
			$('confirm').close()
			$('confirm-send').onclick = null
			$('confirm-cancel').onclick = null
			resolve(answer)
		}
		$('confirm-send').onclick = () => finish(true)
		$('confirm-cancel').onclick = () => finish(false)
	})
}
const hdcpLabel = (row, value) => (row.kind === 'I' ? INPUT_HDCP : OUTPUT_HDCP).find(([id]) => id === value)?.[1] ?? value
const edidLabel = (id) => {
	const slot = snapshot.edids.find((candidate) => candidate.id === id)
	return slot ? slotLabel(slot) : id
}

async function post(path, body) {
	const response = await fetch(base + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const reply = await response.json().catch(() => ({}))
	return { ok: response.ok, reply, status: response.status }
}

$('apply').addEventListener('click', async () => {
	const changed = rows.filter((row) => changesOf(row).length > 0)
	if (!changed.length) return
	const lines = []
	let live = []
	let renegotiate = false
	for (const row of changed) {
		for (const field of changesOf(row)) {
			if (field === 'name') {
				const typed = row.name.value.trim()
				const plain = plainName(typed)
				lines.push((row.kind === 'R' ? 'Router name' : row.port + ': name') + ' to "' + plain + '"' + (plain === typed ? '' : ' (typed as "' + typed + '")'))
			}
			if (field === 'edid') lines.push(row.port + ': EDID to ' + edidLabel(row.edid.value))
			if (field === 'hdcp') lines.push(row.port + ': HDCP to ' + hdcpLabel(row, row.hdcp.value))
			if (field !== 'name') renegotiate = true
			if (field !== 'name' && row.signal && !live.includes(row.port)) live.push(row.port)
		}
	}
	let warning = ''
	if (renegotiate) warning = 'EDID and HDCP changes can make sources and displays renegotiate, which can drop their picture.'
	if (live.length) warning += ' These inputs have a live signal now: ' + live.join(', ') + '.'
	if (!(await ask('Send ' + lines.length + ' change(s) to the router?', lines, warning))) return

	const body = { names: [], inputHdcp: [], outputHdcp: [], edids: [] }
	const routerRow = changed.find((row) => row.kind === 'R')
	if (routerRow) body.routerName = plainName(routerRow.name.value)
	for (const row of changed) {
		for (const field of changesOf(row)) {
			if (field === 'name' && row.kind !== 'R') body.names.push({ port: row.port, name: plainName(row.name.value) })
			if (field === 'edid') body.edids.push({ port: row.number, slot: row.edid.value })
			if (field === 'hdcp') (row.kind === 'I' ? body.inputHdcp : body.outputHdcp).push({ port: row.number, value: row.hdcp.value })
		}
	}
	const sent = new Map(changed.map((row) => [row.port, { name: plainName(row.name.value), edid: row.edid?.value, hdcp: row.hdcp?.value, fields: changesOf(row) }]))
	lastApplied = new Map(changed.map((row) => [row.port, { ...row.original }]))
	$('apply').disabled = true
	say('Sending...')
	let result
	applying = true
	try {
		result = await post('ports', body)
	} catch {
		say('Cannot reach Companion, nothing was sent.', true)
		refreshApply()
		return
	} finally {
		applying = false
	}
	if (!result.ok || !result.reply.snapshot) {
		say('Nothing was sent: ' + (result.reply.error || result.status), true)
		refreshApply()
		return
	}
	$('revert').disabled = false
	render(result.reply.snapshot)
	const errors = result.reply.errors || {}
	let problems = 0
	for (const row of rows) {
		const wanted = sent.get(row.port)
		if (!wanted) { setStatus(row, ''); continue }
		const notes = []
		for (const field of wanted.fields) {
			const error = errors[row.port + ' ' + field]
			if (error) notes.push(field + ': ' + error)
			else if (wanted[field] !== row.original[field]) notes.push('Router kept "' + row.original[field] + '"')
		}
		problems += notes.length
		setStatus(row, notes.join('. ') || 'Saved', notes.length ? 'problem' : 'saved')
	}
	say(problems ? problems + ' change(s) did not take. See the rows below.' : 'Saved.', problems > 0)
})

$('revert').addEventListener('click', () => {
	for (const row of rows) {
		const old = lastApplied.get(row.port)
		if (!old) continue
		row.name.value = old.name
		if (row.edid) setEdid(row, old.edid)
		if (row.hdcp) row.hdcp.value = old.hdcp
		setStatus(row, 'Press Apply to restore')
		refreshRow(row)
	}
	say('The old values are filled in. Press Apply to send them.')
})

$('copy').addEventListener('click', async () => {
	const ports = rows.filter((row) => row.kind !== 'R')
	const text = ['Port\tName\tEDID\tHDCP', ...ports.map((row) => [row.port, row.original.name, row.original.edid ?? '', row.original.hdcp].join('\t'))].join('\n')
	try {
		await navigator.clipboard.writeText(text)
		say('Copied ' + ports.length + ' ports.')
	} catch {
		// the clipboard needs a secure page, which a plain http address on the network isn't
		const area = document.createElement('textarea')
		area.value = text
		document.body.append(area)
		area.select()
		const copied = document.execCommand('copy')
		area.remove()
		say(copied ? 'Copied ' + ports.length + ' ports.' : 'The browser would not allow copying.', !copied)
	}
})

async function slotAction(path, body, title, lines, warning) {
	if (!(await ask(title, lines, warning))) return
	const unsaved = rows.some((row) => changesOf(row).length > 0)
	const result = await post(path, body).catch(() => undefined)
	if (!result || !result.ok || !result.reply.snapshot) {
		say('The router did not do that: ' + ((result && result.reply.error) || 'cannot reach Companion'), true)
		return
	}
	snapshot = result.reply.snapshot
	if (unsaved) {
		say('Done. Press Reload to see it in the tables, which also discards your changes that are waiting.')
	} else {
		render(snapshot)
		say('Done.')
	}
}
// ---- regions: each remembers whether it was open, in this browser ----
for (const region of document.querySelectorAll('details.region')) {
	try {
		const saved = localStorage.getItem('lw3-' + region.id)
		if (saved !== null) region.open = saved === 'open'
	} catch {
		// private browsing can refuse storage, and every region then starts open
	}
	region.addEventListener('toggle', () => {
		try {
			localStorage.setItem('lw3-' + region.id, region.open ? 'open' : 'closed')
		} catch {
			// as above
		}
	})
}

// ---- router presets ----
const PRESET_NAME = /^[A-Za-z0-9_-]{1,46}$/
let presetTimer
/** The module reads a preset once the router announces it, so give it a moment first */
function presetsSoon() {
	clearTimeout(presetTimer)
	presetTimer = setTimeout(loadPresets, 700)
}
async function loadPresets() {
	const data = await fetch(base + 'presets').then((response) => response.json()).catch(() => undefined)
	if (data && data.presets) renderPresets(data.presets)
}
let presetNames = []
function renderPresets(presets) {
	presetNames = presets.map((preset) => preset.name)
	const body = $('presets').tBodies[0]
	body.replaceChildren(...presets.map((preset) => {
		const tr = document.createElement('tr')
		const name = document.createElement('th')
		name.className = 'port'
		name.textContent = preset.name
		if (preset.slots.length) {
			const slot = document.createElement('div')
			slot.className = 'note'
			slot.textContent = 'Front panel ' + preset.slots.join(', ')
			name.append(slot)
		}
		const routes = document.createElement('td')
		routes.className = 'note'
		routes.textContent = preset.routes.map((input, index) => (index + 1) + ': ' + (input ? 'I' + input : '-')).join('  ') + (preset.live ? '  (live now)' : '')
		const buttons = document.createElement('td')
		buttons.className = 'buttons'
		for (const [label, run] of [['Save', savePreset], ['Rename', (n) => copyPreset(n, true)], ['Copy', (n) => copyPreset(n, false)], ['Delete', deletePreset]]) {
			const button = document.createElement('button')
			button.textContent = label
			button.setAttribute('aria-label', label + ' ' + preset.name)
			button.addEventListener('click', () => run(preset.name))
			buttons.append(button)
		}
		tr.append(name, routes, buttons)
		return tr
	}))
}
async function presetPost(action, body, done, show) {
	const result = await post('preset/' + action, body).catch(() => undefined)
	if (!result || !result.ok) {
		const why = 'The router did not do that: ' + ((result && result.reply.error) || 'cannot reach Companion')
		if (show) show(why)
		else say(why, true)
		return false
	}
	renderPresets(result.reply.presets)
	say(done)
	return true
}
/** What's wrong with a new preset name, or nothing. The router's own preset list is checked as well. */
function presetNameProblem(name, original) {
	if (!name) return 'Type a name.'
	if (!PRESET_NAME.test(name)) return 'Only letters, digits, - and _ can be used, up to 46 of them. No spaces.'
	if (name !== original && presetNames.includes(name)) return name + ' already exists.'
	return ''
}
/** Stays open, saying what's wrong, until the name is good and the router has accepted it */
function askPresetName(title, start, original, send) {
	const dialog = $('preset-name')
	const input = $('preset-name-input')
	const problem = $('preset-name-problem')
	const button = $('preset-name-send')
	$('preset-name-title').textContent = title
	input.value = start
	const check = () => {
		const name = input.value.trim()
		const wrong = name === original ? 'That is its name already.' : presetNameProblem(name, original)
		// nothing shows until something has been typed, so the dialog doesn't open with a complaint
		problem.textContent = input.value === start ? '' : wrong
		button.disabled = wrong !== ''
	}
	input.oninput = check
	check()
	$('preset-name-cancel').onclick = () => dialog.close()
	dialog.querySelector('form').onsubmit = async (event) => {
		event.preventDefault()
		if (button.disabled) return
		button.disabled = true
		problem.textContent = ''
		if (await send(input.value.trim(), (why) => { problem.textContent = why })) dialog.close()
		else button.disabled = false
	}
	dialog.showModal()
	input.select()
}
async function savePreset(name) {
	if (!(await ask('Overwrite ' + name + '?', ['With what is routed now'], 'Its old routes are lost. Anything staged is not saved.'))) return
	await presetPost('save', { name }, name + ' saved.')
}
function copyPreset(name, rename) {
	askPresetName((rename ? 'Rename ' : 'Copy ') + name + ' to:', name + (rename ? '' : '-COPY'), name, (to, show) =>
		presetPost(rename ? 'rename' : 'copy', { name, to }, name + (rename ? ' renamed to ' : ' copied to ') + to + '.', show))
}
async function deletePreset(name) {
	if (!(await ask('Delete ' + name + '?', [name], 'Buttons that recall it will stop working.'))) return
	await presetPost('delete', { name }, name + ' deleted.')
}
$('create-preset').addEventListener('click', async () => {
	const name = $('new-preset').value.trim()
	const wrong = presetNameProblem(name, '')
	if (wrong) return say(wrong, true)
	if (!(await ask('Create ' + name + '?', ['From what is routed now'], ''))) return
	if (await presetPost('create', { name }, name + ' created.')) $('new-preset').value = ''
})

/** Asks first, naming the port, as a mistaken tap drops a picture */
async function hotplugPort(row, button) {
	const label = row.port + ' (' + row.original.name + ')'
	let warning = ''
	if (row.kind === 'I') {
		const feeds = await fetch(base + 'feeds?input=' + row.number).then((response) => response.json()).catch(() => undefined)
		const outputs = feeds && feeds.outputs
		warning = !outputs
			? 'Every output this input feeds drops its picture too.'
			: outputs.length
				? 'These outputs drop their picture too: ' + outputs.join(', ') + '.'
				: 'This input feeds no outputs.'
	}
	if (!(await ask('Hotplug ' + label + '?', [row.kind === 'I' ? 'Hotplug off for 2 seconds, then on' : '5V off for 2 seconds, then on'], warning))) return
	button.disabled = true
	setStatus(row, 'Hotplugging...')
	const result = await post('hotplug', { port: row.port }).catch(() => undefined)
	button.disabled = false
	if (result && result.ok) setStatus(row, 'Hotplugged', 'saved')
	else setStatus(row, (result && result.reply.error) || 'Cannot reach Companion', 'problem')
}
const inputsUsing = (id) => rows.filter((row) => row.original.edid === id).map((row) => row.port)

$('store').addEventListener('click', () => {
	const from = $('store-from').value
	const to = $('store-to').value
	const slot = snapshot.edids.find((candidate) => candidate.id === to)
	const using = inputsUsing(to)
	let warning = ''
	if (slot && slot.valid) warning = to + ' already holds ' + slot.name.trim() + ', which will be overwritten.'
	if (using.length) warning += ' ' + using.join(', ') + ' use ' + to + ' now.'
	slotAction('edid/store', { from, to }, 'Store this EDID?', [edidLabel(from) + ' into ' + to], warning)
})
$('delete').addEventListener('click', () => {
	const slot = $('delete-slot').value
	const using = inputsUsing(slot)
	const warning = using.length ? using.join(', ') + ' use ' + slot + ' now, and would be left emulating nothing.' : ''
	slotAction('edid/delete', { slot }, 'Delete this stored EDID?', [edidLabel(slot)], warning)
})

async function load() {
	say('Reading the router...')
	let response
	try {
		response = await fetch(base + 'ports')
	} catch {
		say('Cannot reach Companion. Press Reload to try again.', true)
		return
	}
	if (!response.ok) {
		say('Companion is not connected to the router. Press Reload to try again.', true)
		return
	}
	const data = await response.json()
	routerAddress = data.router
	render(data)
	for (const row of rows) setStatus(row, '')
	say('')
	loadPresets()
	if (!live) startLive()
}

/** Reads and Apply go through the module. This only listens, straight to the router, as Companion can't push to a page. */
// presets being added or deleted are only announced on /MEDIA/PRESET, and changes to one only on /MEDIA/PRESET/*
const LIVE_SUBSCRIPTIONS = ['OPEN /MEDIA/NAMES/VIDEO', 'OPEN /EDID', 'OPEN /MEDIA/XP/VIDEO', 'OPEN /MANAGEMENT/UID', 'OPEN /MANAGEMENT/POWER', 'OPEN /MEDIA/PRESET', 'OPEN /MEDIA/PRESET/*']
const HEARTBEAT_MS = 5000
const RETRY_MS = 5000
function showLive(on) {
	$('live').textContent = on ? 'Live' : 'Not live'
	$('live').className = on ? 'on' : ''
}
function stopLive() {
	clearInterval(liveBeat)
	clearTimeout(liveRetry)
	if (live) {
		live.onclose = null
		live.close()
		live = undefined
	}
	showLive(false)
}
function lostLive() {
	stopLive()
	missedChanges = true
	liveRetry = setTimeout(startLive, RETRY_MS)
}
function startLive() {
	stopLive()
	if (!routerAddress || document.hidden) return
	let socket
	try {
		socket = new WebSocket('ws://' + routerAddress)
	} catch {
		// a page served over https may not open a plain WebSocket
		lostLive()
		return
	}
	live = socket
	// a * only reaches one level down, whatever the whitepaper says, so each port needs its own
	const waiting = [...LIVE_SUBSCRIPTIONS, ...rows.filter((row) => row.kind !== 'R').map((row) => 'OPEN /MEDIA/PORTS/VIDEO/' + row.port + '/SETTINGS')]
	let buffer = ''
	let heard = Date.now()
	socket.onopen = () => socket.send(waiting.shift() + '\r\n')
	socket.onclose = lostLive
	socket.onmessage = (event) => {
		heard = Date.now()
		buffer += event.data
		const lines = buffer.split('\r\n')
		buffer = lines.pop()
		for (const line of lines) {
			if (/^(NEW|DEL|CHG) \/MEDIA\/PRESET\//.test(line) || line.startsWith('CHG /MEDIA/XP/VIDEO.DestinationConnectionStatus')) presetsSoon()
			if (line.startsWith('CHG ')) liveChange(line)
			else if (line.startsWith('o- ')) {
				if (waiting.length) socket.send(waiting.shift() + '\r\n')
				else {
					showLive(true)
					if (missedChanges) catchUp()
				}
			}
		}
	}
	// the router says nothing while nothing changes, and "Live" mustn't outlast a pulled cable
	liveBeat = setInterval(() => {
		if (socket.readyState !== WebSocket.OPEN) return
		if (Date.now() - heard > HEARTBEAT_MS * 2) lostLive()
		else socket.send('GET /.ProductName\r\n')
	}, HEARTBEAT_MS)
}
const rowOf = (port) => rows.find((row) => row.port === port)
/** Keeps what someone is editing, and only moves what the edit is compared with */
function applyLive(row, field, value) {
	if (!row || !row[field] || row.original[field] === value) return
	const edited = changesOf(row).includes(field)
	row.original[field] = value
	if (!edited) {
		if (field === 'edid') setEdid(row, value)
		else row[field].value = value
	}
	if (!applying) setStatus(row, edited ? 'The router now has ' + (field === 'edid' ? edidLabel(value) : field === 'hdcp' ? hdcpLabel(row, value) : value) : 'Changed elsewhere')
	refreshRow(row)
}
function liveChange(line) {
	const match = /^CHG (\S*?)\.(\w+)=(.*)$/.exec(line)
	if (!match) return
	const [, path, property, value] = match
	const hdcp = /^\/MEDIA\/PORTS\/VIDEO\/([IO]\d+)\/SETTINGS$/.exec(path)
	if (path === '/MEDIA/NAMES/VIDEO') {
		applyLive(rowOf(property), 'name', value.slice(value.indexOf(';') + 1).replace(/\\(.)/g, '$1'))
	} else if (path === '/MANAGEMENT/POWER' && property === 'Operation') {
		$('standby').hidden = value !== 'STANDBY'
	} else if (path === '/MANAGEMENT/UID' && property === 'DeviceLabel') {
		applyLive(rowOf('Router'), 'name', value.replace(/\\(.)/g, '$1'))
	} else if (path === '/EDID' && property === 'EdidStatus') {
		value.split(';').forEach((id, index) => { if (id) applyLive(rowOf('I' + (index + 1)), 'edid', id) })
	} else if (hdcp && (property === 'HdcpVersion' || property === 'HdcpMode')) {
		applyLive(rowOf(hdcp[1]), 'hdcp', value)
	} else if (path === '/MEDIA/XP/VIDEO' && property === 'SourcePortStatus') {
		value.split(';').forEach((entry, index) => {
			const row = rowOf('I' + (index + 1))
			if (row && entry) row.signal = (parseInt(entry[2], 16) & 4) !== 0
		})
	}
}
/** After time away, read what was missed without disturbing anything being edited */
async function catchUp() {
	missedChanges = false
	const response = await fetch(base + 'ports').catch(() => undefined)
	if (!response || !response.ok) return
	const data = await response.json()
	snapshot = data
	applyLive(rowOf('Router'), 'name', data.routerName)
	$('standby').hidden = !data.standby
	for (const [kind, list] of [['I', data.inputs], ['O', data.outputs]]) {
		for (const item of list) {
			const row = rowOf(kind + item.port)
			if (!row) continue
			applyLive(row, 'name', item.name)
			applyLive(row, 'hdcp', item.hdcp)
			if (kind === 'I') {
				applyLive(row, 'edid', item.edid)
				row.signal = item.signal
			}
		}
	}
	fillEdidLists()
	loadPresets()
}
document.addEventListener('visibilitychange', () => {
	if (document.hidden) {
		stopLive()
		missedChanges = true
	} else startLive()
})
$('reload').addEventListener('click', load)
load()
</script>
</body>
</html>
`
