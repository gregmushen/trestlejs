import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

export type VerifyEmailProps = { verificationUrl: string; expiresAt?: Date };
export function verifyEmailTemplate(props: VerifyEmailProps): EmailTemplate<VerifyEmailProps> {
  return { name: "verify-email", props, render: () => <EmailLayout preview="Verify your email address"><h1>Verify your email</h1><p>Confirm your email address to finish setting up your account.</p><p><a href={props.verificationUrl}>Verify email address</a></p>{props.expiresAt ? <p>This link expires {props.expiresAt.toISOString()}.</p> : null}</EmailLayout> };
}
