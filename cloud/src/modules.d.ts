/** ブラウザで動かすスクリプト。wrangler.jsonc の rules で、文字列として取り込む。 */
declare module "*.client.js" {
  const source: string;
  export default source;
}
