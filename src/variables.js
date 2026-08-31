module.exports = {
	initVariables() {
		const definitions = {}
		for (const [variableId, name] of Object.entries(this.variables)) {
			definitions[variableId] = { name }
		}
		this.setVariableDefinitions(definitions)
	},
}
