import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	commonjs: true,
	ignores: ['pkg/**', 'node_modules/**', '*.tgz', 'src/icons.js'],
})

export default [
	...baseConfig,
	{
		// the entrypoint and this config are ES modules
		files: ['**/*.mjs'],
		languageOptions: { sourceType: 'module' },
	},
]
