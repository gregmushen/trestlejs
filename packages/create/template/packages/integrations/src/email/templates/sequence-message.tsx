import React from "react";
import type { EmailTemplate } from "../types.js";
import { EmailLayout } from "./layout.js";

/** One email of a `defineSequence` sequence. Marketing sequences pass the signed one-click unsubscribe link. */
export type SequenceMessageProps = { heading: string; paragraphs: string[]; action?: { label: string; url: string }; unsubscribeUrl?: string | null };
export function sequenceMessageTemplate(name: string, props: SequenceMessageProps): EmailTemplate<SequenceMessageProps> {
  return { name, props, render: () => <EmailLayout preview={props.heading}><h1>{props.heading}</h1>{props.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}{props.action ? <p><a href={props.action.url}>{props.action.label}</a></p> : null}{props.unsubscribeUrl ? <p style={{ color: "#667085", fontSize: 12 }}><a href={props.unsubscribeUrl}>Unsubscribe</a> from these emails.</p> : null}</EmailLayout> };
}
