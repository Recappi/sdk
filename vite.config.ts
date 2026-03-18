import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {
    sortPackageJson: true,
    printWidth: 120,
    sortImports: {
      groups: [
        ['type-import'],
        ['type-builtin', 'value-builtin'],
        ['type-external', 'value-external', 'type-internal', 'value-internal'],
        ['type-parent', 'type-sibling', 'type-index', 'value-parent', 'value-sibling', 'value-index'],
        ['unknown'],
      ],
      newlinesBetween: true,
      order: 'asc',
    },
    semi: false,
    singleQuote: true,
  },
  staged: {
    '*.@(js|ts|tsx|toml)': ['vp lint --fix', 'vp fmt'],
    '*.@(yml|yaml|md|json)': ['vp fmt'],
  },
})
