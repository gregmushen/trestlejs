export const site = {
  name: "Southwind",
  description: "A simpler way for teams to organize work, automate routine processes, and stay aligned.",
  tagline: "Run your business without fighting your software.",
  socialImage: "/social-preview.svg",
} as const;

export const navigation = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
] as const;

export function appLink(pathname: string, appUrl = "http://localhost:42069"): string {
  const origin = new URL(appUrl);
  return new URL(pathname.replace(/^\//u, ""), `${origin.toString().replace(/\/$/u, "")}/`).toString();
}
