import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

export type SecurityAlertProps = { summary: string; occurredAt: Date };
export function securityAlertTemplate(props: SecurityAlertProps): EmailTemplate<SecurityAlertProps> {
  return { name: "security-alert", props, render: () => <EmailLayout preview="Security alert"><h1>Security alert</h1><p>{props.summary}</p><p>{props.occurredAt.toISOString()}</p></EmailLayout> };
}
