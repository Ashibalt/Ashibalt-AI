import { describe, it, expect } from "vitest";
import { getAgentSystemPrompt, getChatSystemPrompt } from "../src/promptUtils";

describe("getAgentSystemPrompt", () => {
  it("should return prompt with environment section", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("<ENVIRONMENT>");
    expect(prompt).toContain("</ENVIRONMENT>");
    expect(prompt).toContain("<environment>");
  });

  it("should include Ashibalt identity", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("Ashibalt");
    expect(prompt).toContain("coding agent");
  });

  it("should include workflow section", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("<WORKFLOW>");
    expect(prompt).toContain("UNDERSTAND");
    expect(prompt).toContain("PLAN");
    expect(prompt).toContain("IMPLEMENT");
    expect(prompt).toContain("VERIFY");
    expect(prompt).toContain("COMPLETE");
  });

  it("should include rules section", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("<RULES>");
    expect(prompt).toContain("edit_file");
    expect(prompt).toContain("read_file");
  });

  it("should include key rules", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("diagnose");
    expect(prompt).toContain("NEVER");
    expect(prompt).toContain("background");
  });

  it("should NOT include project tree (lazy loading)", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).not.toContain("<PROJECT>");
    expect(prompt).not.toContain("project_tree");
  });

  it("should include environment info", () => {
    const prompt = getAgentSystemPrompt();
    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("<os>");
    expect(prompt).toContain("<shell>");
  });
});

describe("getChatSystemPrompt", () => {
  it("should return XML prompt structure", () => {
    const prompt = getChatSystemPrompt();
    expect(prompt).toContain("<system>");
    expect(prompt).toContain("</system>");
    expect(prompt).toContain("<identity>");
    expect(prompt).toContain("<communication>");
  });

  it("should include Ashibalt identity with traits", () => {
    const prompt = getChatSystemPrompt();
    expect(prompt).toContain("<name>Ashibalt</name>");
    expect(prompt).toContain("Senior software developer");
    expect(prompt).toContain("<traits>");
  });

  it("should indicate read-only tools in chat mode", () => {
    const prompt = getChatSystemPrompt();
    expect(prompt).toContain("<limitations>");
    expect(prompt).toContain("READ-ONLY tools");
    expect(prompt).toContain("CANNOT edit");
  });

  it("should suggest switching to Agent mode", () => {
    const prompt = getChatSystemPrompt();
    expect(prompt).toContain("Agent mode");
  });
});
