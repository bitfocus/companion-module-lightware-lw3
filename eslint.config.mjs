import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

export default [
	...baseConfig,
	{
		// command line tools for reading a router, not part of the module
		files: ['tools/**/*.mjs'],
		rules: {
			'n/hashbang': 'off',
			'n/no-process-exit': 'off',
		},
	},
	{
		// tests may import dev dependencies
		files: ['src/**/__tests__/**/*.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
			'@typescript-eslint/unbound-method': 'off', // asserting on mocks
		},
	},
]
