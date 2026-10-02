import * as z from "zod";

const statusPositionSchema = z.enum(["inline", "below"]);
const footerStyleSchema = z.enum(["default", "p10k"]);

export type StatusPosition = z.infer<typeof statusPositionSchema>;
export type FooterStyle = z.infer<typeof footerStyleSchema>;

export const footerConfigSchema = z.object({
  statusPosition: statusPositionSchema.optional(),
  /** `p10k` uses nerd-font icons and a lean powerlevel10k left prompt. Path stays fish-shortened. */
  style: footerStyleSchema.optional(),
});
