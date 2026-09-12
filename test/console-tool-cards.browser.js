// Run with playwright-cli run-code --filename test/console-tool-cards.browser.js.
async function checkConsoleCards(page) {
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.reload();
  const desktop = page.locator('.desktop-shell');
  const skill = desktop
    .locator('.tool-sequence')
    .filter({ hasText: 'skill tool' });
  await skill.locator('.code-card-head').click();
  check(
    (
      await skill.getByLabel('Arguments', { exact: true }).textContent()
    ).includes('example'),
    'Named tool arguments are missing',
  );
  await skill.locator('.code-result').click();
  check(
    (
      await skill.getByLabel('Returned value', { exact: true }).textContent()
    ).includes('SKILL_RESULT_MARKER'),
    'Named tool result is missing',
  );
  const review = desktop
    .locator('.tool-sequence')
    .filter({ hasText: 'Research console patterns' });
  await review.locator('.code-result').click();
  check(
    (
      await review.getByLabel('Returned value', { exact: true }).textContent()
    ).includes('FINAL_RESULT_MARKER'),
    'Full return value is missing',
  );
  check(
    (
      await review.getByLabel('Console', { exact: true }).textContent()
    ).includes('CONSOLE_END_MARKER'),
    'Console output is missing',
  );
  check(
    (await review.locator('.tool-output img').count()) === 0,
    'Output was interpreted as HTML',
  );
  check(
    (await desktop.locator('.send-surface').count()) === 0,
    'Tool output became a send',
  );
  await review
    .getByRole('button', { name: 'Copy returned value', exact: true })
    .click();
  check(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      'FINAL_RESULT_MARKER',
    ),
    'Copy did not include the full return value',
  );
  const output = review
    .locator('.tool-output')
    .filter({ has: page.getByLabel('Returned value', { exact: true }) });
  await output.getByRole('button', { name: 'Wrap', exact: true }).click();
  check(
    (await output
      .getByRole('button', { name: 'Wrap', exact: true })
      .getAttribute('aria-pressed')) === 'false',
    'Wrap control did not toggle',
  );
  await review.locator('.raw-receipt summary').click();
  check(
    (
      await review.getByLabel('Raw result', { exact: true }).textContent()
    ).startsWith('[run ok'),
    'Raw result lost its envelope',
  );
  await review.locator('.code-card-head').click();
  check(
    (await review.getByLabel('Source', { exact: true }).textContent()).includes(
      'elpis.search',
    ),
    'Source cannot be expanded independently',
  );
  await review
    .getByRole('button', { name: 'Copy source', exact: true })
    .click();
  check(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      "elpis.search('persistent agent console design')",
    ),
    'Source copy changed authored code',
  );
  await review.locator('.code-card-head').click();
  await review.locator('.code-result').click();
  check(
    (await review.getByLabel('Returned value', { exact: true }).count()) === 0,
    'Result did not collapse',
  );
  const command = review.locator('.runtime-operation');
  await command
    .getByRole('button', { name: 'Expand output', exact: true })
    .click();
  check(
    (
      await command.getByLabel('stdout', { exact: true }).textContent()
    ).includes('COMMAND_END_MARKER'),
    'Command output cannot be expanded',
  );
  check(
    (await command
      .getByText(
        'Output was truncated by the runtime. Only the retained portion is available.',
        { exact: true },
      )
      .count()) === 1,
    'Truncation was not disclosed',
  );
  check(
    !(
      await command.getByLabel('stdout', { exact: true }).textContent()
    ).includes('FINAL_RESULT_MARKER'),
    'Run result was misattributed to a command',
  );
  const write = review.locator('.operation-file');
  check(
    (await write.count()) === 1,
    'Runtime ledger suppressed the filesystem write',
  );
  await write.locator('.operation-compact').click();
  check(
    (
      await write.getByLabel('Argument 2', { exact: true }).textContent()
    ).includes('Check narrow screens'),
    'Write content cannot be inspected',
  );
  const mind = review.locator('.operation-mind');
  check((await mind.count()) === 1, 'Mind list source action was hidden');
  check(
    (await mind.locator('.operation-mind-link').count()) === 0,
    'Nonliteral Mind target became a navigation link',
  );
  await desktop
    .getByRole('button', { name: 'Show before / after', exact: true })
    .click();
  check(
    (await desktop.getByLabel('After', { exact: true }).textContent()).includes(
      'Expandable results',
    ),
    'Short edit cannot show the full after value',
  );
  const orphan = desktop
    .locator('.code-card')
    .filter({ hasText: 'call outside loaded history' });
  await orphan.locator('.code-result').click();
  check(
    (
      await orphan.getByLabel('Returned value', { exact: true }).textContent()
    ).includes('ORPHAN_END_MARKER'),
    'Unpaired result is hidden',
  );
  const failed = desktop
    .locator('.tool-sequence')
    .filter({ hasText: 'Check a missing fixture' });
  await failed.locator('.code-result').focus();
  await page.keyboard.press('Enter');
  check(
    (await failed.locator('.code-result').getAttribute('aria-expanded')) ===
      'true',
    'Result cannot be opened by keyboard',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = page.locator('.mobile-shell');
  const mobileReview = mobile
    .locator('.tool-sequence')
    .filter({ hasText: 'Research console patterns' });
  await mobileReview.locator('.code-result').click();
  check(
    (
      await mobileReview
        .getByLabel('Returned value', { exact: true })
        .textContent()
    ).includes('FINAL_RESULT_MARKER'),
    'Mobile result expansion failed',
  );
  const bounds = await mobileReview.boundingBox();
  check(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391,
    'Mobile card overflows the viewport',
  );
  check(
    await mobile
      .locator('.thread-scroll')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
    'Mobile content causes horizontal overflow',
  );
  await mobileReview.locator('.code-result').click();
  await mobileReview
    .locator('.operation-web .operation-compact')
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.playwright-cli/console-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await desktop.locator('.thread-scroll').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: '.playwright-cli/console-desktop-top.png' });
  return {
    passed: [
      'full results',
      'console separation',
      'literal output',
      'copy',
      'wrap',
      'raw receipt',
      'source',
      'command attribution',
      'filesystem writes',
      'Mind provenance',
      'short edit',
      'unpaired results',
      'keyboard',
      'mobile expansion',
      'mobile overflow',
    ],
  };
}
