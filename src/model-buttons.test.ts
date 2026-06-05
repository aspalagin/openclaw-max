import { describe, expect, it } from "vitest";
import {
  buildMaxModelBrowseChannelData,
  buildMaxModelsAddProviderChannelData,
  buildMaxModelsListChannelData,
  buildMaxModelsMenuChannelData,
} from "./model-buttons.js";

describe("кнопки выбора моделей для MAX", () => {
  it("строит кнопки провайдеров со slash-командами", () => {
    const data = buildMaxModelsMenuChannelData({
      providers: [
        { id: "openai", count: 12 },
        { id: "anthropic", count: 7 },
        { id: "google", count: 3 },
      ],
    });

    expect(data).toEqual({
      max: {
        buttons: [
          [
            { text: "openai (12)", payload: "/models openai" },
            { text: "anthropic (7)", payload: "/models anthropic" },
          ],
          [{ text: "google (3)", payload: "/models google" }],
        ],
      },
    });
  });

  it("строит список моделей, выбор, пагинацию и возврат", () => {
    const data = buildMaxModelsListChannelData({
      provider: "openai",
      models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
      currentModel: "openai/gpt-5-mini",
      currentPage: 2,
      totalPages: 3,
      pageSize: 1,
    });

    expect(data).toEqual({
      max: {
        buttons: [
          [{ text: "gpt-5-mini ✓", payload: "/model openai/gpt-5-mini" }],
          [
            { text: "◀ Назад", payload: "/models openai page=1" },
            { text: "2/3", payload: "/models openai page=2" },
            { text: "Вперёд ▶", payload: "/models openai page=3" },
          ],
          [{ text: "← Назад", payload: "/models" }],
        ],
      },
    });
  });

  it("строит кнопки добавления и обзора", () => {
    expect(buildMaxModelsAddProviderChannelData({ providers: [{ id: "openai" }] })).toEqual({
      max: { buttons: [[{ text: "openai", payload: "/models add openai" }]] },
    });
    expect(buildMaxModelBrowseChannelData()).toEqual({
      max: { buttons: [[{ text: "Выбрать провайдера", payload: "/models" }]] },
    });
  });
});
