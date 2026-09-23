import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

export type NotificationEmailProps = { title: string; body: string; url?: string };
/** Email channel for application notifications (packages/domain/src/notifications). */
export function notificationTemplate(props: NotificationEmailProps): EmailTemplate<NotificationEmailProps> {
  return { name: "notification", props, render: () => <EmailLayout preview={props.title}><h1>{props.title}</h1><p>{props.body}</p>{props.url ? <p><a href={props.url}>View in the app</a></p> : null}<p style={{ color: "#667085", fontSize: 12 }}>Change which notifications you receive in your notification preferences.</p></EmailLayout> };
}
