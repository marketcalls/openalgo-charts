import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

// One entry point per loadable tier (see ARCHITECTURE.md §2).
const entries = {
  index: 'src/index.ts',
  trade: 'src/trade/index.ts',
  transform: 'src/transform/index.ts',
  profile: 'src/profile/index.ts',
};

const outFile = {
  index: 'openalgo-charts',
  trade: 'openalgo-charts.trade',
  transform: 'openalgo-charts.transform',
  profile: 'openalgo-charts.profile',
};

const typesFile = {
  index: 'index',
  trade: 'trade/index',
  transform: 'transform/index',
  profile: 'profile/index',
};

const js = Object.entries(entries).map(([key, input]) => ({
  input,
  output: {
    file: `dist/${outFile[key]}.mjs`,
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    terser({ format: { comments: false } }),
  ],
}));

const types = Object.entries(entries).map(([key, input]) => ({
  input,
  output: { file: `dist/${typesFile[key]}.d.ts`, format: 'es' },
  plugins: [dts()],
}));

export default [...js, ...types];
