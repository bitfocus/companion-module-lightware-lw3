import type { DropdownChoice } from '@companion-module/base'
import type { RouterState } from './state.js'

export function inputChoices(state: RouterState): DropdownChoice<string>[] {
	return Array.from({ length: state.shownInputs }, (_, index) => ({
		id: `I${index + 1}`,
		label: `${index + 1}: ${state.inputName(index + 1)}`,
	}))
}

export function outputChoices(state: RouterState): DropdownChoice<string>[] {
	return Array.from({ length: state.shownOutputs }, (_, index) => ({
		id: `O${index + 1}`,
		label: `${index + 1}: ${state.outputName(index + 1)}`,
	}))
}

export function portChoices(state: RouterState): DropdownChoice<string>[] {
	return [...inputChoices(state), ...outputChoices(state)]
}

export function presetChoices(state: RouterState): DropdownChoice<string>[] {
	return [...state.presets.keys()].map((name) => ({ id: name, label: name }))
}

/** `I3` or `O3` to 3 */
export function portNumber(value: unknown, kind: 'I' | 'O'): number | undefined {
	const match = new RegExp(`^${kind}(\\d+)$`).exec(String(value))
	const port = match ? Number(match[1]) : 0
	return port > 0 ? port : undefined
}
