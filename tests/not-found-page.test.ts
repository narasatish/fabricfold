/* The 404 screen was the framework default ("404 | This page could not be
   found." - no branding, no way back). A student who mistypes a link or opens an
   old one was left at a dead end. Found in the Sep 21 QA pass. */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import NotFound from "../app/not-found";

describe("not-found page", () => {
  const html = renderToString(createElement(NotFound));
  it("says what happened in plain words", () => {
    expect(html).toMatch(/couldn(&#x27;|')t find that page/i);
  });
  it("gives a way home and a way to sign in", () => {
    expect(html).toMatch(/href="\/"/);
    expect(html).toMatch(/href="\/login"/);
  });
  it("is branded", () => {
    expect(html).toContain("FabricFold");
  });
});
