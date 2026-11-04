import type { CompanionVariableDefinitions, CompanionVariableValues } from '@companion-module/base'
import type { RouterState } from './state.js'

/** Variable ids depend on the router's size, so values are an open record */
export type VariablesSchema = CompanionVariableValues

export const nameVar = (port: string): string => `name_${port}`
export const sourceVar = (output: number): string => `source_O${output}`
export const sourceNameVar = (output: number): string => `sourcename_O${output}`
export const stagedNameVar = (output: number): string => `stagedname_O${output}`

export function UpdateVariableDefinitions(
	setDefinitions: (definitions: CompanionVariableDefinitions<VariablesSchema>) => void,
	state: RouterState,
): void {
	const definitions: CompanionVariableDefinitions<VariablesSchema> = {
		model: { name: 'Router model' },
		firmware: { name: 'Router firmware' },
		inputs: { name: 'Number of inputs' },
		outputs: { name: 'Number of outputs' },
		auto_route_mode: { name: 'Auto-route mode (OFF, STAGE or CUT)' },
		live_preset: { name: "Router preset matching the router's routes, or None" },
		selected_input_label: { name: 'Selected input name, or IN while none is selected (for button text)' },
		selected_output_label: { name: 'Selected output name, or OUT while none is selected (for button text)' },
		selected_output_source: { name: 'Name of what is on the selected output' },
		selected_output_lock_text: { name: 'Lock button text for the selected output, e.g. LOCK + name' },
	}
	for (let input = 1; input <= state.shownInputs; input++) {
		definitions[nameVar(`I${input}`)] = { name: `Name of input ${input}` }
	}
	for (let output = 1; output <= state.shownOutputs; output++) {
		definitions[nameVar(`O${output}`)] = { name: `Name of output ${output}` }
		definitions[sourceVar(output)] = { name: `Input routed to output ${output} (I1, or 0 for none)` }
		definitions[sourceNameVar(output)] = { name: `Name of the input routed to output ${output}, or None` }
		definitions[stagedNameVar(output)] = { name: `Name of the input staged for output ${output} (empty when none)` }
	}
	setDefinitions(definitions)
}

export function portNameValues(state: RouterState): VariablesSchema {
	const values: VariablesSchema = {}
	for (let input = 1; input <= state.shownInputs; input++) values[nameVar(`I${input}`)] = state.inputName(input)
	for (let output = 1; output <= state.shownOutputs; output++) values[nameVar(`O${output}`)] = state.outputName(output)
	return values
}

export function routeValues(state: RouterState): VariablesSchema {
	const values: VariablesSchema = {}
	for (let output = 1; output <= state.shownOutputs; output++) {
		const input = state.routes.get(output)
		values[sourceVar(output)] = input === undefined ? '' : input === 0 ? '0' : `I${input}`
		values[sourceNameVar(output)] = state.routedName(output)
		values[stagedNameVar(output)] = state.stagedName(output)
	}
	return values
}

export function selectionValues(state: RouterState): VariablesSchema {
	const { selectedInput, selectedOutput } = state
	return {
		selected_input_label: selectedInput === undefined ? 'IN' : state.inputName(selectedInput),
		selected_output_label: selectedOutput === undefined ? 'OUT' : state.outputName(selectedOutput),
		selected_output_source: selectedOutput === undefined ? '' : state.routedName(selectedOutput),
		selected_output_lock_text:
			selectedOutput === undefined
				? '[UN]LOCK\nOUT'
				: `${state.isLocked(selectedOutput) ? 'UNLOCK' : 'LOCK'}\n${state.outputName(selectedOutput)}`,
		live_preset: state.livePreset ?? 'None',
	}
}
