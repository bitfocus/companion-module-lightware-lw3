/**
 * Reads an option value, tolerating both plain values and the wrapped form used
 * once an option can hold an expression.
 */
function optionValue(option) {
	if (option !== null && typeof option === 'object' && 'value' in option) return option.value
	return option
}

/**
 * The Output Lock action used to pick its port with a number field called
 * 'output'. It now shares a named port dropdown with the Input Lock action, so
 * existing buttons are moved over to it.
 */
function outputLockPortDropdown(_context, props) {
	const updatedActions = []

	for (const action of props.actions) {
		if (action.actionId !== 'outputLock') continue
		if (action.options.output === undefined || action.options.port !== undefined) continue

		const port = parseInt(optionValue(action.options.output))
		action.options.port = Number.isFinite(port) ? `O${port}` : ''
		delete action.options.output

		updatedActions.push(action)
	}

	return {
		updatedConfig: null,
		updatedActions,
		updatedFeedbacks: [],
	}
}

module.exports = [outputLockPortDropdown]
