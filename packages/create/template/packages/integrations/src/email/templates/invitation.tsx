import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

export type InvitationProps = { organizationName: string; invitationUrl: string };
export function invitationTemplate(props: InvitationProps): EmailTemplate<InvitationProps> {
  return { name: "invitation", props, render: () => <EmailLayout preview={`Join ${props.organizationName}`}><h1>You’re invited</h1><p>You have been invited to join {props.organizationName}.</p><p><a href={props.invitationUrl}>Accept invitation</a></p></EmailLayout> };
}
