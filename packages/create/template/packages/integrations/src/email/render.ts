import { render } from "@react-email/render";
import type { EmailTemplate } from "./types.js";

export async function renderEmail(template: EmailTemplate): Promise<{ html: string; text: string }> {
  const element = template.render();
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
