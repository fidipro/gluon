// Stands in for the plugin's own /llms.txt route (the vite plugin in astro.config.mjs swaps the
// entrypoint; a project page with the same URL only warns of a collision): same format, but every
// page, under the sidebar's group names (llms.mjs).
import { getCollection } from "astro:content";
import type { APIRoute } from "astro";
import { description, sidebarOrder, siteOriginFallback, title } from "virtual:starlight-llm-tools/config";
import { llmsTxt } from "../llms.mjs";

export const prerender = true;

// The base path comes from Astro (site/base.mjs sets it), not from that file: a bundled route cannot read it at run time.
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export const GET: APIRoute = async ({ site }) => {
  const docs = (await getCollection("docs")).filter((d) => d.id !== "404").map((d) => ({ id: d.id, title: d.data.title, description: d.data.description }));
  const body = llmsTxt(docs, { title, description, origin: (site?.origin ?? siteOriginFallback) + basePath, order: sidebarOrder });
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
