import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

export type ResetPasswordProps = { resetUrl: string; expiresAt?: Date };
export function resetPasswordTemplate(props: ResetPasswordProps): EmailTemplate<ResetPasswordProps> {
  return { name: "reset-password", props, render: () => <EmailLayout preview="Reset your password"><h1>Reset your password</h1><p>If you requested a password reset, continue below.</p><p><a href={props.resetUrl}>Reset password</a></p>{props.expiresAt ? <p>This link expires {props.expiresAt.toISOString()}.</p> : null}</EmailLayout> };
}
