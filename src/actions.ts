import {
	INPUT_EXPRESSION,
	OUTPUT_EXPRESSION,
	PORT_EXPRESSION,
	LAST_PRESSED_EXPRESSION,
	inputChoices,
	outputChoices,
	portChoices,
	portNumber,
	presetChoices,
	INPUT_VALUE,
	OUTPUT_VALUE,
	PORT_VALUE,
	SELECTED_PORT_VALUE,
} from './choices.js'
import type ModuleInstance from './main.js'
import { HOTPLUG_DEFAULT_SECONDS, HOTPLUG_MAX_SECONDS } from './protocol.js'

type NoOptions = Record<string, never>

export type LockCommand = 'lockDestination' | 'unlockDestination' | 'toggle'
export type MuteCommand = 'mute' | 'unmute' | 'toggle'
export type PowerCommand = 'standby' | 'wake' | 'toggle'
export type DefaultNamesScope = 'all' | 'inputs' | 'outputs' | 'router'

export type ActionsSchema = {
	xpt: { options: { input: string; output: string } }
	unroute: { options: { output: string; useSelected?: boolean } }
	preset: { options: { preset: string } }
	savePreset: { options: { preset: string } }
	createPreset: { options: { name: string } }
	armSave: { options: NoOptions }
	recallSlot: { options: { slot: number } }
	selectSource: { options: { port: string } }
	selectDestination: { options: { port: string } }
	take: { options: NoOptions }
	takeSalvo: { options: NoOptions }
	routeToAll: { options: { input: string } }
	stageSelected: { options: NoOptions }
	stageRoute: { options: { input: string; output: string } }
	takeStaged: { options: NoOptions }
	clearStaged: { options: NoOptions }
	setAutoRoute: { options: { mode: string } }
	outputLock: { options: { output: number; cmd: string; useSelected?: boolean } }
	mute: { options: { port: string; cmd: string } }
	lockPort: { options: { port: string; cmd: string } }
	hotplugOutput: { options: { output: string; useSelected?: boolean; seconds: number } }
	hotplugInput: { options: { input: string; seconds: number } }
	rename: { options: { port: string; name: string } }
	softreset: { options: NoOptions }
	setDefaultNames: { options: { scope: string } }
	power: { options: { cmd: string } }
	setClock: { options: Record<string, never> }
}

export function UpdateActions(self: ModuleInstance): void {
	const { state } = self
	const inputs = inputChoices(state)
	const outputs = outputChoices(state)
	const presets = presetChoices(state)
	const hotplugSeconds = {
		type: 'number' as const,
		id: 'seconds' as const,
		label: 'Off for (seconds, HDMI only)',
		default: HOTPLUG_DEFAULT_SECONDS,
		min: 0.5,
		max: HOTPLUG_MAX_SECONDS,
		step: 0.5,
	}

	self.setActionDefinitions({
		xpt: {
			name: 'Route: switch this input to this output now',
			options: [
				{
					type: 'dropdown',
					id: 'input',
					label: 'Input',
					default: 'I1',
					choices: inputs,
					expressionDescription: INPUT_EXPRESSION,
					...INPUT_VALUE,
				},
				{
					type: 'dropdown',
					id: 'output',
					label: 'Output',
					default: 'O1',
					choices: outputs,
					expressionDescription: OUTPUT_EXPRESSION,
					...OUTPUT_VALUE,
				},
			],
			callback: async (action) =>
				self.routeNow(portNumber(action.options.input, 'I'), portNumber(action.options.output, 'O')),
		},
		unroute: {
			name: 'Unroute an output',
			description: 'Follows the auto-route mode: in Stage this is staged, and otherwise it happens straight away.',
			options: [
				{
					type: 'dropdown',
					id: 'output',
					isVisibleExpression: '!$(options:useSelected)',
					label: 'Output',
					default: 'O1',
					choices: outputs,
					expressionDescription: OUTPUT_EXPRESSION,
					...OUTPUT_VALUE,
				},
				{
					type: 'checkbox',
					id: 'useSelected',
					disableAutoExpression: true,
					label: 'Use the selected output (ignores the output above)',
					default: false,
				},
			],
			callback: async (action) =>
				self.clearRoute(action.options.useSelected ? state.selectedOutput : portNumber(action.options.output, 'O')),
		},
		preset: {
			name: 'Recall a router preset',
			description:
				'Loads a preset stored on the router. If the auto-route mode is Stage, its routes are staged instead. A name can be typed if the router is offline.',
			options: [
				{
					type: 'dropdown',
					id: 'preset',
					label: 'Router preset',
					default: presets[0]?.id ?? '',
					choices: presets,
					allowCustom: true,
				},
			],
			callback: async (action) => self.recallPreset(String(action.options.preset)),
		},
		savePreset: {
			name: 'Overwrite a router preset with the current routes',
			description:
				'Its old routes are lost. Only what is routed now is saved: take any staged routes first. There is no one-press preset for this on purpose.',
			options: [
				{
					type: 'dropdown',
					id: 'preset',
					label: 'Router preset',
					default: presets[0]?.id ?? '',
					choices: presets,
					allowCustom: true,
				},
			],
			callback: async (action) => {
				await self.savePreset(String(action.options.preset))
			},
		},
		createPreset: {
			name: 'Create a router preset from the current routes',
			description: 'Up to 46 letters, digits, - and _. Nothing happens if the name is already in use.',
			options: [{ type: 'textinput', id: 'name', label: 'Name', default: 'NEW-001' }],
			callback: async (action) => {
				await self.createPreset(String(action.options.name))
			},
		},
		recallSlot: {
			name: 'Recall a front-panel preset',
			description:
				"Recalls the router preset on one of the router's front-panel preset buttons, or stages it with auto-route on Stage. With SAVE waiting, saves into it instead, making a new preset if it is empty.",
			options: [
				{
					type: 'number',
					id: 'slot',
					label: 'Front-panel preset',
					default: 1,
					min: 1,
					max: 64,
					step: 1,
					asInteger: true,
				},
			],
			callback: async (action) => self.recallSlot(Number(action.options.slot)),
		},
		armSave: {
			name: 'Save: the next router preset pressed is overwritten',
			description:
				'Press it, then within 5 seconds press a router preset to overwrite it, or an input to save to that front-panel preset. With routes staged, what a take would leave is saved. Pressing it again, or anything else, cancels.',
			options: [],
			callback: () => self.armSave(),
		},
		selectSource: {
			name: 'Select an input',
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Input',
					default: 'I1',
					choices: inputs,
					expressionDescription: INPUT_EXPRESSION,
					...INPUT_VALUE,
				},
			],
			callback: (action) => self.selectInput(portNumber(action.options.port, 'I')),
		},
		selectDestination: {
			name: 'Select an output',
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Output',
					default: 'O1',
					choices: outputs,
					expressionDescription: OUTPUT_EXPRESSION,
					...OUTPUT_VALUE,
				},
			],
			callback: (action) => self.selectOutput(portNumber(action.options.port, 'O')),
		},
		take: {
			name: 'Take: send the staged routes and the selected input and output',
			description: 'They are sent as one command, and the router changes them together.',
			options: [],
			callback: async () => self.take(),
		},
		routeToAll: {
			name: 'Route an input to every output',
			description:
				'Follows the auto-route mode: with Cut every output changes now, in one command, and with Off or Stage they are staged for TAKE. Locked outputs are left as they are.',
			options: [
				{
					type: 'dropdown',
					id: 'input',
					label: 'Input',
					default: 'I1',
					choices: inputs,
					expressionDescription: INPUT_EXPRESSION,
					...INPUT_VALUE,
				},
			],
			callback: async (action) => self.routeToAll(portNumber(action.options.input, 'I')),
		},
		takeSalvo: {
			name: 'Take the selected input to the selected output only, and clear the selection',
			options: [],
			callback: async () => self.takeSelection(),
		},
		stageSelected: {
			name: 'Stage the selected input and output for a later take',
			options: [],
			callback: () => self.stageSelection(),
		},
		stageRoute: {
			name: 'Stage a route: this input to this output',
			description: 'Stage one route without using the selection. Add several, then Take the staged routes.',
			options: [
				{
					type: 'dropdown',
					id: 'input',
					label: 'Input',
					default: 'I1',
					choices: inputs,
					expressionDescription: INPUT_EXPRESSION,
					...INPUT_VALUE,
				},
				{
					type: 'dropdown',
					id: 'output',
					label: 'Output',
					default: 'O1',
					choices: outputs,
					expressionDescription: OUTPUT_EXPRESSION,
					...OUTPUT_VALUE,
				},
			],
			callback: (action) => self.stage(portNumber(action.options.input, 'I'), portNumber(action.options.output, 'O')),
		},
		takeStaged: {
			name: 'Take the staged routes',
			description: 'They are sent as one command, and the router changes them together.',
			options: [],
			callback: async () => self.takeStaged(),
		},
		clearStaged: {
			name: 'Clear the staged routes',
			options: [],
			callback: () => self.clearStaged(),
		},
		setAutoRoute: {
			name: 'Set auto-route mode',
			description: 'What happens when an input and an output are both selected. Saved in the connection settings.',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: 'next',
					choices: [
						{ id: 'next', label: 'Next mode (off, stage, cut, off)' },
						{ id: 'off', label: 'Off: wait for the take button' },
						{ id: 'stage', label: 'Stage: stage straight away' },
						{ id: 'cut', label: 'Cut: take straight away' },
					],
				},
			],
			callback: (action) => self.setAutoRouteMode(String(action.options.mode)),
		},
		outputLock: {
			name: 'Lock or unlock an output',
			options: [
				{
					type: 'number',
					id: 'output',
					isVisibleExpression: '!$(options:useSelected)',
					label: 'Output',
					default: 1,
					min: 1,
					max: 512,
					step: 1,
					asInteger: true,
				},
				{
					type: 'checkbox',
					id: 'useSelected',
					disableAutoExpression: true,
					label: 'Use the selected output (ignores the output above)',
					default: false,
				},
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Lock',
					default: 'toggle',
					expressionDescription: "'toggle', 'lockDestination' or 'unlockDestination', in quotes",
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'lockDestination', label: 'Lock' },
						{ id: 'unlockDestination', label: 'Unlock' },
					],
				},
			],
			callback: async (action) =>
				self.lockOutput(
					action.options.useSelected ? state.selectedOutput : Number(action.options.output),
					String(action.options.cmd) as LockCommand,
				),
		},
		lockPort: {
			name: 'Lock or unlock a port',
			description:
				"A locked output keeps its route. A locked input can't be routed anywhere else, and every output showing it is frozen too.",
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Port',
					default: 'selected',
					choices: [{ id: 'selected', label: 'The input or output pressed last' }, ...portChoices(state)],
					expressionDescription: LAST_PRESSED_EXPRESSION,
					...SELECTED_PORT_VALUE,
				},
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Lock',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'lock', label: 'Lock' },
						{ id: 'unlock', label: 'Unlock' },
					],
				},
			],
			callback: async (action) =>
				self.lockPort(String(action.options.port), String(action.options.cmd) as 'lock' | 'unlock' | 'toggle'),
		},
		mute: {
			name: 'Mute or unmute a port',
			description:
				'A muted port stays routed and sends black without dropping its signal. Muting an input blacks every output it feeds. A locked output cannot be muted or unmuted.',
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Port',
					default: 'selected',
					choices: [{ id: 'selected', label: 'The input or output pressed last' }, ...portChoices(state)],
					expressionDescription: LAST_PRESSED_EXPRESSION,
					...SELECTED_PORT_VALUE,
				},
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Mute',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
					],
				},
			],
			callback: async (action) => self.mutePort(String(action.options.port), String(action.options.cmd) as MuteCommand),
		},
		hotplugOutput: {
			name: 'Hotplug an output (5V off and on, or DP link train)',
			description:
				'Looks to the display as if its cable was pulled and put back, which can wake one that has lost its picture. Only this output is affected.',
			options: [
				{
					type: 'dropdown',
					id: 'output',
					isVisibleExpression: '!$(options:useSelected)',
					label: 'Output',
					default: 'O1',
					choices: outputs,
					expressionDescription: OUTPUT_EXPRESSION,
					...OUTPUT_VALUE,
				},
				{
					type: 'checkbox',
					id: 'useSelected',
					disableAutoExpression: true,
					label: 'Use the selected output (ignores the output above)',
					default: false,
				},
				hotplugSeconds,
			],
			callback: async (action) => {
				const output = action.options.useSelected ? state.selectedOutput : portNumber(action.options.output, 'O')
				await self.hotplug(output === undefined ? undefined : `O${output}`, Number(action.options.seconds))
			},
		},
		hotplugInput: {
			name: 'Hotplug an input (HPD off and on, or DP link train)',
			description:
				'Makes the source read the EDID again, such as after an EDID change it missed. Every output this input feeds drops its picture too. It does nothing useful if the source fakes its own EDID. There is no preset for this on purpose.',
			options: [
				{
					type: 'dropdown',
					id: 'input',
					label: 'Input',
					default: 'I1',
					choices: inputs,
					expressionDescription: INPUT_EXPRESSION,
					...INPUT_VALUE,
				},
				hotplugSeconds,
			],
			callback: async (action) => {
				const input = portNumber(action.options.input, 'I')
				await self.hotplug(input === undefined ? undefined : `I${input}`, Number(action.options.seconds))
			},
		},
		rename: {
			name: 'Rename a port',
			options: [
				{
					type: 'dropdown',
					id: 'port',
					label: 'Port',
					default: 'I1',
					choices: portChoices(state),
					expressionDescription: PORT_EXPRESSION,
					...PORT_VALUE,
				},
				{ type: 'textinput', id: 'name', label: 'New name', default: 'New name' },
			],
			callback: async (action) => self.renamePort(String(action.options.port), String(action.options.name)),
		},
		power: {
			name: 'Put the router in standby, or wake it',
			description:
				'In standby every output is off, and the router refuses any change until it wakes. Signals took about 20 s to come back after waking. There is no preset for this on purpose.',
			options: [
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Standby',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'standby', label: 'Standby' },
						{ id: 'wake', label: 'Wake' },
					],
				},
			],
			callback: async (action) => self.setPower(String(action.options.cmd) as PowerCommand),
		},
		setClock: {
			name: "Set the router's clock to Companion's time",
			description:
				'Uses the time on the computer running Companion. The router has no time zone, so this needs doing again when the clocks change.',
			options: [],
			callback: async () => {
				await self.setRouterClock()
			},
		},
		setDefaultNames: {
			name: 'Set names to default',
			description:
				"Input 1, Output 1 and so on, and the model as the router name. It replaces the names straight away and can't be undone from here. There is no preset for this on purpose: the ports page has a Default names button that asks first and can be reverted.",
			options: [
				{
					type: 'dropdown',
					id: 'scope',
					label: 'Names',
					default: 'all',
					choices: [
						{ id: 'all', label: 'All ports and the router name' },
						{ id: 'inputs', label: 'Inputs' },
						{ id: 'outputs', label: 'Outputs' },
						{ id: 'router', label: 'Router name' },
					],
				},
			],
			callback: async (action) => self.setDefaultNames(String(action.options.scope) as DefaultNamesScope),
		},
		softreset: {
			name: 'Soft reset the router',
			description: 'Restarts the router, which interrupts the connection. There is no preset for this on purpose.',
			options: [],
			callback: async () => self.softReset(),
		},
	})
}
