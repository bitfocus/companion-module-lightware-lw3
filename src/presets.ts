import {
	ButtonGraphicsDecorationType,
	ButtonGraphicsShowStatusIcons,
	type CompanionButtonStepActions,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
} from '@companion-module/base'
import { BUTTON_PNG_BASE64 } from './button-image.js'
import type { FeedbacksSchema } from './feedbacks.js'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import { HOTPLUG_DEFAULT_SECONDS } from './protocol.js'
import { nameVar, slotVar, sourceNameVar, stagedNameVar } from './variables.js'

// Companion swaps this for the connection's label wherever it appears in preset text
const VAR = '$(lightware-lw3:'
/** Companion's own feedback, lit for as long as the button is held */
const PUSHED = 'internal:buttonPushed'

const CONTROL = 0xdadada
const CONTROL_PUSHED = 0xffffff
const DESTINATION = 0x808000
const SOURCE = 0x008000
const SELECTED_DST = 0xffff00
const SELECTED_SRC = 0x00ff00
const STAGED = 0xff8000
const LOCKED = 0xff0000
const MUTED = 0x0050ff
/** Router presets and front-panel presets at rest. Bright enough for black text, unlike the dark purple tried first. */
const PRESET = 0xff00ff
/** The router web interface's port legend. Not connected has no border, as that says enough. */
const LEGEND: [string, number][] = [
	['connected', 0xfffb00],
	['dvi', 0xffb300],
	['hdmi', 0xb3ddff],
	['hdmi18', 0x007ee6],
]
/** In percent of the button. A border stays visible at the angle a Stream Deck's keys are read from. */
const LEGEND_BORDER_WIDTH = 3
/** Companion's alpha is in the top byte, and this much of it is clear */
const TRANSPARENT = 0xff000000

/** Holding an input this long sends it to every output */
const HOLD_MS = 1000

/** Text starts large and shrinks to fit its layer */
const FONT_SIZE = 100
/** For text that changes while the button is in use, so its size doesn't jump */
const CHANGING_TEXT_FONT_SIZE = 32

interface Bounds {
	x: number
	y: number
	width: number
	height: number
}

const FULL: Bounds = { x: 5, y: 5, width: 90, height: 90 }
/** Layout, in percent of the button, of the stacked output button */
const STACK = {
	output: { x: 5, y: 5, width: 90, height: 30 },
	cross: { x: 40, y: 25, width: 20, height: 20 },
	current: { x: 5, y: 35, width: 90, height: 30 },
	arrow: { x: 40, y: 55, width: 20, height: 20 },
	staged: { x: 5, y: 65, width: 90, height: 30 },
}

const textLayer = (
	id: string,
	name: string,
	text: string,
	bounds: Bounds,
	enabled = true,
	fontsize = FONT_SIZE,
	color = 0x000000,
) =>
	({
		type: 'text',
		id,
		name,
		enabled,
		...bounds,
		text,
		color,
		halign: 'center',
		valign: 'center',
		fontsize,
		fontsizeAllowShrink: true,
		font: 'companion-mono',
		outlineColor: 0xff000000,
	}) as const

type PresetActions = CompanionButtonStepActions<ModuleSchema>['down']

type PresetFeedback = (
	| { [K in keyof FeedbacksSchema]: { feedbackId: K; options: FeedbacksSchema[K]['options'] } }[keyof FeedbacksSchema]
	| { feedbackId: typeof PUSHED; options: Record<string, never> }
) & {
	/** Left out to leave the colour to other feedbacks */
	background?: number
	/** Layers hidden until this feedback is true */
	shows?: string[]
	/** Layers hidden while this feedback is true */
	hides?: string[]
	/** What the plain fallback says while this feedback is true */
	fallbackText?: string
}

interface ButtonSpec {
	name: string
	background: number
	actions: PresetActions
	feedbacks: PresetFeedback[]
	/** A port to show the status of, as a coloured border on the layered button */
	legendPort?: string
	/** For a dark background: the text colour at rest, turning black whenever a feedback colours the button */
	textColor?: number
	/** Run once the button has been held for HOLD_MS. The press actions then run on a short press, at release. */
	holdActions?: PresetActions
}

const legendBorder = {
	type: 'box' as const,
	id: 'legend',
	name: 'Port status',
	x: 0,
	y: 0,
	width: 100,
	height: 100,
	color: TRANSPARENT,
	borderWidth: LEGEND_BORDER_WIDTH,
	borderColor: TRANSPARENT,
	borderPosition: 'inside' as const,
}

const legendFeedbacks = (port: string | undefined) =>
	port === undefined
		? []
		: LEGEND.map(([level, color]) => ({
				feedbackId: 'portLegend' as const,
				options: { port, level },
				styleOverrides: [{ elementId: 'legend', elementProperty: 'borderColor', override: color }],
			}))

/** A button in the module style: the image on a coloured background, plus a plain version as a fallback */
function moduleButton(
	spec: ButtonSpec & { layers: ReturnType<typeof textLayer>[]; fallbackText: string },
): CompanionPresetDefinitions<ModuleSchema>[string] {
	const steps: CompanionButtonStepActions<ModuleSchema>[] = [
		spec.holdActions
			? { down: [], up: spec.actions, [HOLD_MS]: { options: { runWhileHeld: true }, actions: spec.holdActions } }
			: { down: spec.actions, up: [] },
	]
	return {
		type: 'alternatives',
		variants: [
			{
				type: 'layered',
				name: spec.name,
				// the house style: the button's own look, without Companion's top bar or status icons
				canvas: { decoration: ButtonGraphicsDecorationType.None, showStatusIcons: ButtonGraphicsShowStatusIcons.None },
				elements: [
					{ type: 'box', id: 'box0', name: 'Background', x: 0, y: 0, width: 100, height: 100, color: spec.background },
					{
						type: 'image',
						id: 'image0',
						name: 'Image',
						x: 0,
						y: 0,
						width: 100,
						height: 100,
						base64Image: `data:image/png;base64,${BUTTON_PNG_BASE64}`,
						fillMode: 'fill',
					},
					...(spec.legendPort ? [legendBorder] : []),
					...spec.layers,
				],
				feedbacks: [
					...legendFeedbacks(spec.legendPort),
					...spec.feedbacks.map(({ background, shows, hides, fallbackText: _text, ...feedback }) => ({
						...feedback,
						styleOverrides: [
							...(background === undefined
								? []
								: [{ elementId: 'box0', elementProperty: 'color', override: background }]),
							...(background === undefined || spec.textColor === undefined
								? []
								: spec.layers.map(({ id }) => ({ elementId: id, elementProperty: 'color', override: 0x000000 }))),
							...(shows ?? []).map((elementId) => ({ elementId, elementProperty: 'enabled', override: true })),
							...(hides ?? []).map((elementId) => ({ elementId, elementProperty: 'enabled', override: false })),
						],
					})),
				],
				steps,
			},
			{
				type: 'simple',
				name: spec.name,
				style: {
					text: spec.fallbackText,
					size: 'auto',
					color: spec.textColor ?? 0x000000,
					bgcolor: spec.background,
					png64: BUTTON_PNG_BASE64,
					show_topbar: false,
				},
				steps,
				feedbacks: spec.feedbacks.map(({ background, shows: _shows, hides: _hides, fallbackText, ...feedback }) => ({
					...feedback,
					style: {
						...(background === undefined ? {} : { bgcolor: background, color: 0x000000 }),
						...(fallbackText === undefined ? {} : { text: fallbackText }),
					},
				})),
			},
		],
	}
}

/** One text layer filling the button */
const textButton = (spec: ButtonSpec & { text: string; fontsize?: number }) =>
	moduleButton({
		...spec,
		layers: [textLayer('text', 'text', spec.text, FULL, true, spec.fontsize, spec.textColor)],
		fallbackText: spec.text,
	})

/** Always last on a control button, so a press shows whatever colour the button has */
const controlPushed: PresetFeedback = { feedbackId: PUSHED, options: {}, background: CONTROL_PUSHED }

export function UpdatePresets(self: ModuleInstance): void {
	const { state } = self
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const control = (id: string, name: string, text: string, actions: PresetActions, fontsize?: number): void => {
		presets[id] = textButton({
			name,
			background: CONTROL,
			text,
			fontsize,
			actions,
			feedbacks: [controlPushed],
		})
	}

	presets.blank = textButton({
		name: 'Blank button in the module style: place it, use Convert to Normal Button, then add your own actions',
		background: CONTROL,
		text: '',
		actions: [],
		feedbacks: [controlPushed],
	})
	// input above output, the `v` overlapping the two names slightly, until routes are waiting
	const takePreview = ['line0', 'line1', 'line2', 'line3']
	presets.take = moduleButton({
		name: 'Take the staged routes and the selected input and output together',
		background: CONTROL,
		layers: [
			textLayer('line0', 'label', 'TAKE', { x: 5, y: 5, width: 90, height: 25 }),
			textLayer('line1', 'input', `${VAR}selected_input_label)`, { x: 5, y: 30, width: 90, height: 30 }),
			textLayer('line2', 'arrow', 'v', { x: 40, y: 52, width: 20, height: 15 }),
			textLayer('line3', 'output', `${VAR}selected_output_label)`, { x: 5, y: 60, width: 90, height: 30 }),
			textLayer('staged', 'staged', 'TAKE\nSTAGED', FULL, false, CHANGING_TEXT_FONT_SIZE),
		],
		fallbackText: `TAKE\n${VAR}selected_input_label)\nv\n${VAR}selected_output_label)`,
		actions: [{ actionId: 'take', options: {} }],
		feedbacks: [
			{ feedbackId: 'stagedRoutes', options: {}, shows: ['staged'], hides: takePreview, fallbackText: 'TAKE\nSTAGED' },
			{ feedbackId: 'stagedWaiting', options: {}, background: STAGED },
			controlPushed,
		],
	})
	control('clear_staged', 'Clear the staged routes', 'CLEAR\nSTAGED', [{ actionId: 'clearStaged', options: {} }])
	control(
		'unroute',
		'Clear the route on the selected output',
		'CLEAR\nXPT',
		[{ actionId: 'unroute', options: { output: 'O1', useSelected: true } }],
		CHANGING_TEXT_FONT_SIZE,
	)
	// as MUTE: the input or output pressed last, red while it is locked
	presets.lock = textButton({
		name: 'Lock or unlock the input or output pressed last',
		background: CONTROL,
		text: `${VAR}selected_lock_text)`,
		fontsize: CHANGING_TEXT_FONT_SIZE,
		actions: [{ actionId: 'lockPort', options: { port: 'selected', cmd: 'toggle' } }],
		feedbacks: [{ feedbackId: 'portLocked', options: { port: 'selected' }, background: LOCKED }, controlPushed],
	})

	presets.save = textButton({
		name: 'Save: press this, then a router preset to overwrite it with the current routes',
		background: CONTROL,
		text: 'SAVE\nPRESET',
		actions: [{ actionId: 'armSave', options: {} }],
		feedbacks: [{ feedbackId: 'saveArmed', options: {}, background: LOCKED }, controlPushed],
	})
	presets.mute = textButton({
		name: 'Mute or unmute the input or output pressed last',
		background: CONTROL,
		text: `${VAR}selected_mute_text)`,
		fontsize: CHANGING_TEXT_FONT_SIZE,
		actions: [{ actionId: 'mute', options: { port: 'selected', cmd: 'toggle' } }],
		feedbacks: [{ feedbackId: 'portMuted', options: { port: 'selected' }, background: MUTED }, controlPushed],
	})
	presets.hotplug = textButton({
		name: 'Hotplug the selected output: 5V off, then on, to wake its display',
		background: CONTROL,
		text: `${VAR}selected_output_hotplug_text)`,
		fontsize: CHANGING_TEXT_FONT_SIZE,
		actions: [
			{ actionId: 'hotplugOutput', options: { output: 'O1', useSelected: true, seconds: HOTPLUG_DEFAULT_SECONDS } },
		],
		feedbacks: [{ feedbackId: 'hotplugging', options: { port: 'selected' }, background: STAGED }, controlPushed],
	})

	presets.auto_route = textButton({
		name: 'Step the auto-route mode: off, stage, cut',
		background: CONTROL,
		text: `AUTO\n${VAR}auto_route_mode)`,
		fontsize: CHANGING_TEXT_FONT_SIZE,
		actions: [{ actionId: 'setAutoRoute', options: { mode: 'next' } }],
		feedbacks: [
			{ feedbackId: 'autoRouteMode', options: { mode: 'stage' }, background: STAGED },
			{ feedbackId: 'autoRouteMode', options: { mode: 'cut' }, background: LOCKED },
			controlPushed,
		],
	})

	const inputIds: string[] = []
	for (let input = 1; input <= state.shownInputs; input++) {
		const options = { port: `I${input}` }
		const name = `${VAR}${nameVar(`I${input}`)})`
		inputIds.push(`input_${input}`)
		presets[`input_${input}`] = textButton({
			name: `Input ${input}`,
			background: SOURCE,
			text: name,
			legendPort: `I${input}`,
			actions: [{ actionId: 'selectSource', options }],
			holdActions: [{ actionId: 'routeToAll', options: { input: `I${input}` } }],
			feedbacks: [
				{ feedbackId: 'routedInput', options: { input: `I${input}` }, background: SELECTED_SRC },
				{ feedbackId: 'sourceSelected', options: { port: input }, background: SELECTED_SRC },
				// above selected, so a muted port always shows it, and below pressed, which lights while held
				{ feedbackId: 'portMuted', options: { port: `I${input}` }, background: MUTED },
				// with SAVE waiting, an input saves to its front-panel preset, so it flashes like the presets
				{ feedbackId: 'saveSlotArmed', options: { slot: input }, background: LOCKED },
				{ feedbackId: 'portLocked', options: { port: `I${input}` }, background: LOCKED },
				{ feedbackId: PUSHED, options: {}, background: SELECTED_SRC },
			],
		})
	}

	const outputIds: string[] = []
	const routedIds: string[] = []
	for (let output = 1; output <= state.shownOutputs; output++) {
		const port = `O${output}`
		const options = { port }
		const name = `${VAR}${nameVar(port)})`
		const feedbacks: PresetFeedback[] = [
			{ feedbackId: 'routedOutput', options: { output: port }, background: SELECTED_DST },
			{ feedbackId: 'destinationSelected', options: { port: output }, background: SELECTED_DST },
			{ feedbackId: 'portMuted', options: { port }, background: MUTED },
			{ feedbackId: PUSHED, options: {}, background: SELECTED_DST },
			{ feedbackId: 'outputStaged', options: { output: port }, background: STAGED },
			{ feedbackId: 'portLocked', options: { port }, background: LOCKED },
		]
		outputIds.push(`output_${output}`)
		presets[`output_${output}`] = textButton({
			name: `Output ${output}`,
			background: DESTINATION,
			text: name,
			legendPort: port,
			actions: [{ actionId: 'selectDestination', options }],
			feedbacks,
		})
		const current = `${VAR}${sourceNameVar(output)})`
		const staged = `[${VAR}${stagedNameVar(output)})]`
		const next = `[${VAR}selected_input_label)]`
		routedIds.push(`routed_${output}`)
		presets[`routed_${output}`] = moduleButton({
			name: `Output ${output} with its routed input`,
			background: DESTINATION,
			legendPort: port,
			layers: [
				textLayer('output', 'this output', name, STACK.output),
				textLayer('cross', 'xpt', 'x', STACK.cross),
				textLayer('current', 'current input', current, STACK.current),
				textLayer('arrow', 'next xpt', 'v', STACK.arrow, false),
				textLayer('staged', 'staged input', staged, STACK.staged, false),
				textLayer('next', 'selected input', next, STACK.staged, false),
			],
			fallbackText: `${name}\n${current}\n${staged}`,
			actions: [{ actionId: 'selectDestination', options }],
			feedbacks: [
				{ feedbackId: 'destinationSelected', options: { port: output }, background: SELECTED_DST },
				{ feedbackId: 'portMuted', options: { port }, background: MUTED },
				{ feedbackId: PUSHED, options: {}, background: SELECTED_DST },
				{ feedbackId: 'outputStaged', options: { output: port }, background: STAGED, shows: ['arrow', 'staged'] },
				{
					feedbackId: 'outputNext',
					options: { output: port },
					shows: ['arrow', 'next'],
					hides: ['staged'],
					fallbackText: `${name}\n${current}\n${next}`,
				},
				{ feedbackId: 'portLocked', options: { port }, background: LOCKED },
			],
		})
	}

	const presetIds: string[] = []
	for (const preset of state.presets.keys()) {
		const id = `preset_${preset}`
		presetIds.push(id)
		presets[id] = textButton({
			name: `Recall router preset ${preset}, or stage it if the auto-route mode is Stage`,
			background: PRESET,
			text: preset,
			actions: [{ actionId: 'preset', options: { preset } }],
			feedbacks: [
				{ feedbackId: 'presetLive', options: { preset }, background: SELECTED_SRC },
				{ feedbackId: 'presetStaged', options: { preset }, background: STAGED },
				// every preset flashes while SAVE waits, as any of them could be overwritten
				{ feedbackId: 'saveArmed', options: {}, background: LOCKED },
				controlPushed,
			],
		})
	}

	const slotIds: string[] = []
	for (const slot of state.slots.keys()) {
		const id = `slot_${slot}`
		slotIds.push(id)
		presets[id] = textButton({
			name: `Front-panel preset ${slot}: shows and recalls whatever preset the router has on it`,
			background: PRESET,
			text: `${VAR}${slotVar(slot)})`,
			fontsize: CHANGING_TEXT_FONT_SIZE,
			actions: [{ actionId: 'recallSlot', options: { slot } }],
			feedbacks: [
				{ feedbackId: 'slotLive', options: { slot }, background: SELECTED_SRC },
				{ feedbackId: 'slotStaged', options: { slot }, background: STAGED },
				{ feedbackId: 'saveArmed', options: {}, background: LOCKED },
				controlPushed,
			],
		})
	}

	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'control',
			name: 'Control',
			definitions: [
				{
					id: 'switching',
					type: 'simple',
					name: 'Switching',
					presets: ['blank', 'take', 'clear_staged', 'unroute', 'lock', 'mute', 'hotplug', 'auto_route'],
				},
			],
		},
		{
			id: 'router_presets',
			name: 'Router presets',
			definitions: [
				{ id: 'router_presets', type: 'simple', name: 'Router presets', presets: ['save', ...presetIds] },
				{ id: 'slots', type: 'simple', name: "The router's front-panel preset buttons", presets: slotIds },
			],
		},
		{
			id: 'outputs',
			name: 'Outputs',
			definitions: [
				{ id: 'outputs', type: 'simple', name: 'Outputs', presets: outputIds },
				{ id: 'routed', type: 'simple', name: 'Outputs showing their routed input', presets: routedIds },
			],
		},
		{
			id: 'inputs',
			name: 'Inputs',
			definitions: [{ id: 'inputs', type: 'simple', name: 'Inputs', presets: inputIds }],
		},
	]

	self.setPresetDefinitions(structure, presets)
}
