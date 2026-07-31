// Bun supports `import sql from "./x.sql" with { type: "text" }`, embedding the
// file as a string. tsc needs this ambient declaration to type such imports.
declare module "*.sql" {
  const content: string;
  export default content;
}
