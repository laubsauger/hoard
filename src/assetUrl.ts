// Resolve a RUNTIME asset path (GLBs, textures fetched at run time — NOT bundler imports) against the app's
// configured base URL. Vite rewrites `import`ed assets at build time, but string paths passed to loaders/fetch
// are opaque to it, so an absolute `/meshes/x.glb` would 404 when the app is served from a sub-path
// (GitHub Pages project site at `/hoard/`). `import.meta.env.BASE_URL` is `/` in dev and `/hoard/` in the
// deployed build (both trailing-slash), so prefixing here makes the same path correct in every environment.
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
