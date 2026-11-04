import { inputChoices, outputChoices, portChoices, portNumber, presetChoices } from './choices.js'
import type ModuleInstance from './main.js'

type NoOptions = Record<string, never>

export type LockCommand = 'lockDestination' | 'unlockDestination' | 'toggle'

export type ActionsSchema = {
	xpt: { options: { input: string; output: string } }
	unroute: { options: { output: string; useSelected?: boolean } }
	preset: { options: { preset: string } }
	selectSource: { options: { port: string } }
	selectDestination: { options: { port: string } }
	takeSalvo: { options: NoOptions }
	stageSelected: { options: NoOptions }
	stageRoute: { options: { input: string; output: string } }
	takeStaged: { options: NoOptions }
	clearStaged: { options: NoOptions }
	setAutoRoute: { options: { mode: string } }
	outputLock: { options: { output: number; cmd: string; useSelected?: boolean } }
	rename: { options: { port: string; name: string } }
	softreset: { options: NoOptions }
}

export function UpdateActions(self: ModuleInstance): void {
	const { state } = self
	const inputs = inputChoices(state)
	const outputs = outputChoices(state)
	const presets = presetChoices(state)

	self.setActionDefinitions({
		xpt: {
			name: 'Route: switch this input to this output now',
			options: [
				{ type: 'dropdown', id: 'input', label: 'Input', default: 'I1', choices: inputs },
				{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs },
			],
			callback: async (action) =>
				self.routeNow(portNumber(action.options.input, 'I'), portNumber(action.options.output, 'O')),
		},
		unroute: {
			name: 'Unroute an output',
			description: 'Follows the auto-route mode: in Stage this is staged, and otherwise it happens straight away.',
			options: [
				{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs },
				{
					type: 'checkbox',
					id: 'useSelected',
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
		selectSource: {
			name: 'Select an input',
			options: [{ type: 'dropdown', id: 'port', label: 'Input', default: 'I1', choices: inputs }],
			callback: (action) => self.selectInput(portNumber(action.options.port, 'I')),
		},
		selectDestination: {
			name: 'Select an output',
			options: [{ type: 'dropdown', id: 'port', label: 'Output', default: 'O1', choices: outputs }],
			callback: (action) => self.selectOutput(portNumber(action.options.port, 'O')),
		},
		takeSalvo: {
			name: 'Take: route the selected input to the selected output, and clear the selection',
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
				{ type: 'dropdown', id: 'input', label: 'Input', default: 'I1', choices: inputs },
				{ type: 'dropdown', id: 'output', label: 'Output', default: 'O1', choices: outputs },
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
				{ type: 'number', id: 'output', label: 'Output', default: 1, min: 1, max: 512 },
				{
					type: 'checkbox',
					id: 'useSelected',
					label: 'Use the selected output (ignores the output above)',
					default: false,
				},
				{
					type: 'dropdown',
					id: 'cmd',
					label: 'Lock',
					default: 'toggle',
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
		rename: {
			name: 'Rename a port',
			options: [
				{ type: 'dropdown', id: 'port', label: 'Port', default: 'I1', choices: portChoices(state) },
				{ type: 'textinput', id: 'name', label: 'New name', default: 'New name' },
			],
			callback: async (action) => self.renamePort(String(action.options.port), String(action.options.name)),
		},
		softreset: {
			name: 'Soft reset the router',
			description: 'Restarts the router, which interrupts the connection. There is no preset for this on purpose.',
			options: [],
			callback: async () => self.softReset(),
		},
	})
}
