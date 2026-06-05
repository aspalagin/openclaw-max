type MaxButton = {
  text: string;
  payload?: string;
  url?: string;
};

type ProviderInfo = {
  id: string;
  count: number;
};

const MODELS_PAGE_SIZE = 8;

function chunkRows<T>(items: T[], rowSize: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += rowSize) {
    rows.push(items.slice(index, index + rowSize));
  }
  return rows;
}

function truncateModelId(modelId: string, maxLen: number): string {
  if (modelId.length <= maxLen) return modelId;
  return `…${modelId.slice(-(maxLen - 1))}`;
}

function isCurrentModelSelection(params: {
  currentModel?: string;
  provider: string;
  model: string;
}): boolean {
  const currentModel = params.currentModel?.trim();
  if (!currentModel) return false;
  return currentModel.includes("/")
    ? currentModel === `${params.provider}/${params.model}`
    : currentModel === params.model;
}

function maxChannelData(buttons: MaxButton[][]) {
  return buttons.length > 0 ? { max: { buttons } } : null;
}

export function buildMaxProviderKeyboard(providers: ProviderInfo[]): MaxButton[][] {
  return chunkRows(
    providers.map((provider) => ({
      text: `${provider.id} (${provider.count})`,
      payload: `/models ${provider.id}`,
    })),
    2,
  );
}

export function buildMaxModelsKeyboard(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}): MaxButton[][] {
  const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;
  if (params.models.length === 0) {
    return [[{ text: "← Назад", payload: "/models" }]];
  }

  const rows: MaxButton[][] = [];
  const startIndex = (params.currentPage - 1) * pageSize;
  const pageModels = params.models.slice(startIndex, startIndex + pageSize);

  for (const model of pageModels) {
    const fallbackLabel = model.includes("/") ? `${params.provider}/${model}` : model;
    const displayText = truncateModelId(
      params.modelNames?.get(`${params.provider}/${model}`) ?? fallbackLabel,
      38,
    );
    const text = isCurrentModelSelection({
      currentModel: params.currentModel,
      provider: params.provider,
      model,
    })
      ? `${displayText} ✓`
      : displayText;

    rows.push([{ text, payload: `/model ${params.provider}/${model}` }]);
  }

  if (params.totalPages > 1) {
    const paginationRow: MaxButton[] = [];
    if (params.currentPage > 1) {
      paginationRow.push({
        text: "◀ Назад",
        payload: `/models ${params.provider} page=${params.currentPage - 1}`,
      });
    }
    paginationRow.push({
      text: `${params.currentPage}/${params.totalPages}`,
      payload: `/models ${params.provider} page=${params.currentPage}`,
    });
    if (params.currentPage < params.totalPages) {
      paginationRow.push({
        text: "Вперёд ▶",
        payload: `/models ${params.provider} page=${params.currentPage + 1}`,
      });
    }
    rows.push(paginationRow);
  }

  rows.push([{ text: "← Назад", payload: "/models" }]);
  return rows;
}

export function buildMaxBrowseProvidersButton(): MaxButton[][] {
  return [[{ text: "Выбрать провайдера", payload: "/models" }]];
}

export function buildMaxModelsMenuChannelData(params: { providers: ProviderInfo[] }) {
  return maxChannelData(buildMaxProviderKeyboard(params.providers));
}

export function buildMaxModelsProviderChannelData(params: { providers: ProviderInfo[] }) {
  return maxChannelData(buildMaxProviderKeyboard(params.providers));
}

export function buildMaxModelsAddProviderChannelData(params: { providers: Array<{ id: string }> }) {
  return maxChannelData(
    params.providers.map((provider) => [{
      text: provider.id,
      payload: `/models add ${provider.id}`,
    }]),
  );
}

export function buildMaxModelsListChannelData(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}) {
  return { max: { buttons: buildMaxModelsKeyboard(params) } };
}

export function buildMaxModelBrowseChannelData() {
  return { max: { buttons: buildMaxBrowseProvidersButton() } };
}
