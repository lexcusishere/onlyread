// Images imported by a script are bundled as data URLs (scripts/build.mjs `loader`).
declare module '*.png' {
  const url: string;
  export default url;
}
