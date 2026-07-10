import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Калькулятор сплиттеров' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('renders the default building calculator state without templates', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Парадная 1 (1-59)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Парадная 1: 59 кв, 12 эт' })).toBeVisible();
  await expect(page.getByText(/Квартир:\s*59/)).toBeVisible();
  await expect(page.getByText(/Сплиттеров:\s*4/)).toBeVisible();
  await expect(page.getByText('Все сплиттеры')).toBeVisible();
  await expect(page.getByText('Шаблоны')).toHaveCount(0);
  await expect(page.getByText('1/8').first()).toBeVisible();
});

test('selects a splitter and shows its apartment details', async ({ page }) => {
  await page.getByText('Л-2').first().click();

  await expect(page.getByText('Ratio')).toBeVisible();
  await expect(page.getByText('Этажи')).toBeVisible();
  await expect(page.getByText('Квартир', { exact: true })).toBeVisible();
  await expect(page.getByText('1-3, 5-7, 10-12, 15-17кв.')).toBeVisible();
});

test('opens settings and edits floor groups', async ({ page }) => {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Настройки парадной' })).toBeVisible();
  await expect(page.getByText('Группы этажей')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Применить группы' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Пересчитать' })).toBeVisible();
});

test('allows clearing numeric fields and renaming an entrance in settings', async ({ page }) => {
  await page.locator('button').nth(2).click();

  const nameInput = page.locator('input').first();
  await nameInput.fill('Renamed entrance');
  await expect(page.getByRole('heading', { name: /Renamed entrance/ })).toBeVisible();

  const floorsInput = page.locator('input').nth(1);
  await floorsInput.fill('');
  await expect(floorsInput).toHaveValue('');
  await floorsInput.fill('10');
  await expect(page.getByRole('heading', { name: /10/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ð¡Ð¿Ð»Ð¸Ñ‚Ñ‚ÐµÑ€Ñ‹' })).toHaveCount(0);
});

test('creates a single-riser entrance without left-right wording', async ({ page }) => {
  await page.getByRole('button', { name: '+ Добавить' }).click();
  await expect(page.getByRole('heading', { name: 'Новая парадная' })).toBeVisible();

  await page.getByLabel('Название').fill('Парадная single');
  await page.getByLabel('Стояков').selectOption('1');
  await page.getByRole('button', { name: 'Создать' }).click();

  await expect(page.getByRole('button', { name: /Парадная single/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Парадная single/ })).toBeVisible();
  await expect(page.getByText('Л-')).toHaveCount(0);
  await expect(page.getByText('П-')).toHaveCount(0);

  await page.getByRole('button', { name: 'Настройки' }).click();
  await expect(page.getByRole('heading', { name: 'Настройки парадной' })).toBeVisible();
  await expect(page.getByText('Левый')).toHaveCount(0);
  await expect(page.getByText('Правый')).toHaveCount(0);
});

test('deletes an entrance from its tab close button', async ({ page }) => {
  await page.locator('button').filter({ hasText: '+' }).first().click();
  await page.locator('input').first().fill('Tab close test');
  await page.locator('button').last().click();

  await expect(page.getByRole('button', { name: /Tab close test/ })).toBeVisible();
  await page.locator('[data-testid^="delete-entrance-"]').last().click();
  await expect(page.getByRole('button', { name: /Tab close test/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="delete-entrance-"]')).toHaveCount(0);
});

test('keeps splitter columns aligned across floors with different apartment counts', async ({ page }) => {
  const floors = [1, 2, 5, 9, 12];

  const getZoneX = async (side: 'left' | 'right', floor: number) => {
    const box = await page.getByTestId(`splitter-zone-${side}-${floor}`).boundingBox();
    expect(box).not.toBeNull();
    return box!.x;
  };

  for (const side of ['left', 'right'] as const) {
    const xs = await Promise.all(floors.map((floor) => getZoneX(side, floor)));
    for (const x of xs) {
      expect(Math.abs(x - xs[0])).toBeLessThan(0.5);
    }
  }

  await page.screenshot({ path: 'test-results/splitter-column-after.png', fullPage: true });
});
