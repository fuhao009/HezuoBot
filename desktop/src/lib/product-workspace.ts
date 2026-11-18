/** A product-managed workspace: a packaged account build (its workspace window is launched with
 * `--hezuo-product-managed=1`, which is the only time `window.hezuo.productAccount` exists) or a dev
 * server started with `HEZUO_PRODUCT_SERVICE_URL`. The bridge outlives the first config frame, so the
 * window never flashes the ordinary onboarding while the server is still starting. */
export function isProductWorkspace(managed?: boolean): boolean {
  return managed === true || Boolean(typeof window !== "undefined" && window.hezuo?.productAccount);
}
