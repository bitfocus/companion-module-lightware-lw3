import type { DropdownChoice } from '@companion-module/base'
import type { PortId } from './protocol.js'
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

/**
 * What to type when a port dropdown is switched to an expression. An expression needs text in quotes, so
 * a bare I1 means nothing to it. A plain number works where only one kind of port is possible.
 */
export const INPUT_EXPRESSION = 'Input number, such as 1'
export const OUTPUT_EXPRESSION = 'Output number, such as 1'
export const PORT_EXPRESSION = "'I1' for input 1, or 'O1' for output 1, in quotes"
export const LAST_PRESSED_EXPRESSION =
	"'I1' for input 1, 'O1' for output 1, or 'selected' for the one pressed last, in quotes"
export const SELECTED_OUTPUT_EXPRESSION = "Output number, such as 1, or 'selected' in quotes"
export const SELECTED_PORT_EXPRESSION =
	"'I1' for input 1, 'O1' for output 1, or 'selected' for the selected output, in quotes"

/**
 * Companion refuses a value that isn't in the list unless custom values are allowed, so these let a typed
 * number through. A number can only stand alone where just one kind of port is possible.
 */
export const INPUT_VALUE = { allowCustom: true, regex: '/^I?\\d+$/i', allowInvalidValues: true } as const
export const OUTPUT_VALUE = { allowCustom: true, regex: '/^O?\\d+$/i', allowInvalidValues: true } as const
export const PORT_VALUE = { allowCustom: true, regex: '/^[IO]\\d+$/i', allowInvalidValues: true } as const
export const SELECTED_PORT_VALUE = {
	allowCustom: true,
	regex: '/^([IO]\\d+|selected)$/i',
	allowInvalidValues: true,
} as const
export const SELECTED_OUTPUT_VALUE = {
	allowCustom: true,
	regex: '/^(O?\\d+|selected)$/i',
	allowInvalidValues: true,
} as const

/** A port or `selected` as typed, in either case, in the form the router and the state use */
export function portOf(value: unknown): PortId | 'selected' | undefined {
	const text = String(value).trim()
	if (/^selected$/i.test(text)) return 'selected'
	return /^[io]\d+$/i.test(text) ? (text.toUpperCase() as PortId) : undefined
}

/** `I3`, `O3`, or just 3, to 3 */
export function portNumber(value: unknown, kind: 'I' | 'O'): number | undefined {
	// a bare number comes from an expression, as the dropdown's own values always have the letter
	const match = new RegExp(`^${kind}?(\\d+)$`, 'i').exec(String(value).trim())
	const port = match ? Number(match[1]) : 0
	return port > 0 ? port : undefined
}
