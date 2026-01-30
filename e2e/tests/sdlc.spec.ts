import { test, expect, type Page } from '@playwright/test';

const GITEA_URL = process.env.GITEA_URL || 'http://localhost:3000';
const JENKINS_URL = process.env.JENKINS_URL || 'http://localhost:8080';
const NGINX_URL = process.env.NGINX_URL || 'http://localhost:8088';
const SONAR_URL = process.env.SONAR_URL || 'http://localhost:9000';

const GITEA_ADMIN_USER = process.env.GITEA_ADMIN_USER || 'admin';
const GITEA_ADMIN_PASS = process.env.GITEA_ADMIN_PASS || 'admin123!';
const GITEA_ADMIN_EMAIL = process.env.GITEA_ADMIN_EMAIL || 'admin@example.com';

const REPO = process.env.GITEA_REPO || 'hello-world';
const ISSUE_TITLE = process.env.ISSUE_TITLE || 'create hello-world app and deploy it to nginx';

const SONAR_ADMIN_USER = process.env.SONAR_ADMIN_USER || 'admin';
const SONAR_ADMIN_PASS = process.env.SONAR_ADMIN_PASS || 'admin';
const SONAR_NEW_PASS = process.env.SONAR_NEW_PASS || '';

const JENKINS_ADMIN_USER = process.env.JENKINS_ADMIN_USER || 'admin';
const JENKINS_ADMIN_PASS = process.env.JENKINS_ADMIN_PASS || 'admin';

const SONAR_PROJECT_KEY = process.env.SONAR_PROJECT_KEY || 'hello-world';
const SONAR_PROJECT_NAME = process.env.SONAR_PROJECT_NAME || 'hello-world';

function basicAuthHeader(user: string, pass: string) {
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function sonarAuthValidate(page: Page, user: string, pass: string): Promise<boolean> {
  const url = `${SONAR_URL}/api/authentication/validate`;
  try {
    const res = await page.request.get(url, {
      headers: { Authorization: basicAuthHeader(user, pass) },
      timeout: 20_000
    });
    if (!res.ok()) return false;
    const txt = await res.text();
    return txt.includes('"valid":true');
  } catch {
    return false;
  }
}

async function sonarApiLogin(page: Page, user: string, pass: string): Promise<boolean> {
  const url = `${SONAR_URL}/api/authentication/login`;
  try {
    const res = await page.request.post(url, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      form: { login: user, password: pass },
      timeout: 30_000
    });
    return res.ok();
  } catch {
    return false;
  }
}

async function sonarChangePassword(page: Page, user: string, oldPass: string, newPass: string): Promise<void> {
  const url = `${SONAR_URL}/api/users/change_password`;
  // Some Sonar versions require a session cookie (not Basic auth) for this endpoint.
  // Try cookie-auth first (assumes caller has logged in via /api/authentication/login).
  let res = await page.request.post(url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    form: {
      login: user,
      previousPassword: oldPass,
      password: newPass
    },
    timeout: 30_000
  });

  if (res.status() === 401) {
    // Fallback to Basic auth.
    res = await page.request.post(url, {
      headers: {
        Authorization: basicAuthHeader(user, oldPass),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      form: {
        login: user,
        previousPassword: oldPass,
        password: newPass
      },
      timeout: 30_000
    });
  }

  if (!res.ok()) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Failed to change Sonar password via API: ${res.status()} ${txt}`);
  }
}

function basicAuthHeaderFromToken(token: string) {
  const raw = `${token}:`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

async function ensureSonarProjectExistsUi(page: Page) {
  // Check if project already exists by looking for it on the projects page
  await page.goto(`${SONAR_URL}/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Look for the project by checking if the page contains the project key/name
  const pageContent = await page.content();
  if (pageContent.includes(SONAR_PROJECT_KEY) || pageContent.includes(SONAR_PROJECT_NAME)) {
    // Project already exists, skip creation
    return;
  }

  // Also check for a link with the project name
  const existing = page.locator(`a:has-text("${SONAR_PROJECT_NAME}")`).first();
  if (await existing.isVisible().catch(() => false)) return;

  // Go directly to manual project creation URL.
  await page.goto(`${SONAR_URL}/projects/create?mode=manual`, { waitUntil: 'domcontentloaded' });

  const displayName = page.getByRole('textbox', { name: /project display name/i }).first();
  const projectKey = page.getByRole('textbox', { name: /project key/i }).first();
  const mainBranch = page.getByRole('textbox', { name: /main branch name/i }).first();
  await expect(displayName).toBeVisible({ timeout: 60_000 });

  await displayName.fill(SONAR_PROJECT_NAME);
  await projectKey.fill(SONAR_PROJECT_KEY);
  await mainBranch.fill('main');

  const submit = page.getByRole('button', { name: /set up/i }).first();
  await submit.click();
  await page.waitForLoadState('networkidle');

  // Wait a moment for any error messages or success redirect
  await page.waitForTimeout(1000);
}

// Token creation intentionally skipped for now.

async function handleSonarForcedPasswordUpdate(page: Page, oldPass: string): Promise<string> {
  if (!SONAR_NEW_PASS) {
    throw new Error('SonarQube requires password update, but SONAR_NEW_PASS is not set');
  }

  // Never rotate passwords repeatedly. We only change once away from the default.
  if (oldPass !== SONAR_ADMIN_PASS) {
    return oldPass;
  }

  const onResetPage = /\/account\/reset_password/.test(page.url());
  const resetHeading = page.getByRole('heading', { name: /update your password/i });
  const embeddedHeading = page.getByText(/enter a new password/i).first();

  // In newer Sonar UI these are exposed as textboxes with names like:
  // "Old PasswordThis field is required".
  const oldPasswordInput = page.getByRole('textbox', { name: /old password/i }).first();
  const newPasswordInput = page.getByRole('textbox', { name: /new password/i }).first();
  const confirmPasswordInput = page.getByRole('textbox', { name: /confirm password/i }).first();
  const updateButton = page.getByRole('button', { name: /^update$/i }).first();

  const needsReset =
    onResetPage ||
    (await resetHeading.isVisible().catch(() => false)) ||
    (await embeddedHeading.isVisible().catch(() => false)) ||
    (await oldPasswordInput.isVisible().catch(() => false));

  if (!needsReset) return oldPass;

  // Only change the password once when the default admin password is still in effect.
  // Use API change_password (deterministic) instead of flaky UI submission.
  await sonarChangePassword(page, SONAR_ADMIN_USER, SONAR_ADMIN_PASS, SONAR_NEW_PASS);
  return SONAR_NEW_PASS;
}

async function waitForSonarUp(page: Page) {
  const deadline = Date.now() + 3 * 60 * 1000;
  const statusUrl = `${SONAR_URL}/api/system/status`;

  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(statusUrl, { timeout: 10_000 });
      if (res.ok()) {
        const body = await res.text();
        if (body.includes('"status":"UP"') || body.includes('"status":"STARTED"')) {
          return;
        }
      }
    } catch {
      // ignore
    }
    await page.waitForTimeout(2000);
  }

  throw new Error(`SonarQube did not become ready at ${statusUrl}`);
}

async function ensureGiteaInstalled(page: Page) {
  await page.goto(`${GITEA_URL}/`, { waitUntil: 'domcontentloaded' });
  // Detect install page by heading or URL (new Gitea versions may not have form[action="/install"])
  const isInstall = 
    page.url().includes('/install') ||
    await page.getByRole('heading', { name: /initial configuration/i }).isVisible().catch(() => false) ||
    await page.locator('form[action="/install"]').first().isVisible().catch(() => false);
  if (!isInstall) return;

  // Wait for page to be fully loaded
  await page.waitForTimeout(2000);

  // Fill Site Title using role-based selector (matches accessibility tree)
  const siteTitleField = page.getByRole('textbox', { name: /site title/i });
  await siteTitleField.clear();
  await siteTitleField.fill('hello-world');

  // Scroll ALL THE WAY to the bottom of the page FIRST to reveal the Admin section
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // Expand "Administrator Account Settings" section (collapsed by default)
  await page.getByText('Administrator Account Settings').click();
  await page.waitForTimeout(1000);

  // Admin account - fill fields using role-based selectors
  await page.getByRole('textbox', { name: /administrator username/i }).fill(GITEA_ADMIN_USER);
  await page.getByRole('textbox', { name: /^password$/i }).fill(GITEA_ADMIN_PASS);
  await page.getByRole('textbox', { name: /confirm password/i }).fill(GITEA_ADMIN_PASS);
  await page.getByRole('textbox', { name: /email address/i }).fill(GITEA_ADMIN_EMAIL);

  // Scroll to bottom again and click Install button
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  await page.getByRole('button', { name: 'Install Gitea' }).click();

  // Wait for install to complete and redirect
  await page.waitForURL((url) => !url.toString().includes('/install'), { timeout: 120_000 });
  await page.waitForLoadState('networkidle');
}

async function giteaLogin(page: Page) {
  await page.goto(`${GITEA_URL}/`, { waitUntil: 'domcontentloaded' });

  // Check if already logged in (user menu visible or on dashboard)
  const userMenu = page.locator('.ui.dropdown.jump.item, .user-dropdown, [aria-label="Profile and settings"]');
  const isLoggedIn = await userMenu.first().isVisible().catch(() => false);
  if (isLoggedIn) {
    // Already logged in, nothing to do
    return;
  }

  // Detect install page
  const isInstallPage =
    page.url().includes('/install') ||
    await page.getByRole('heading', { name: /initial configuration/i }).isVisible().catch(() => false);

  if (isInstallPage) {
    await ensureGiteaInstalled(page);
    await page.goto(`${GITEA_URL}/`, { waitUntil: 'domcontentloaded' });
    // After install, we're auto-logged in
    return;
  }

  // Go to login page
  await page.goto(`${GITEA_URL}/user/login`, { waitUntil: 'domcontentloaded' });

  // Check again if already logged in (redirected to dashboard)
  if (!page.url().includes('/user/login')) {
    return;
  }

  const form = page.locator('form[action="/user/login"]');
  await expect(form).toBeVisible({ timeout: 60_000 });

  await form.locator('input[name="user_name"], input#user_name, input[type="text"]').first().fill(GITEA_ADMIN_USER);
  await form.locator('input[name="password"], input#password, input[type="password"]').first().fill(GITEA_ADMIN_PASS);
  await form.getByRole('button', { name: /sign in|login/i }).click();
  // Wait for redirect away from login page
  await page.waitForURL((url) => !url.toString().includes('/user/login'), { timeout: 30_000 });
}

async function loginAndEnsureSonarProject(page: Page): Promise<string> {
  // Returns the admin password to use for scanner auth.

  await waitForSonarUp(page);

  // Auth strategy:
  // 1) Try default admin password.
  // 2) If it fails, we assume it has been changed and use SONAR_NEW_PASS from .env.
  // Determine which password works: try default first, then .env.
  let currentSonarPass = SONAR_ADMIN_PASS;
  const defaultLoginOk = await sonarApiLogin(page, SONAR_ADMIN_USER, SONAR_ADMIN_PASS);
  if (!defaultLoginOk) {
    if (!SONAR_NEW_PASS) {
      throw new Error('SonarQube default admin password failed and SONAR_NEW_PASS is not set');
    }
    const newLoginOk = await sonarApiLogin(page, SONAR_ADMIN_USER, SONAR_NEW_PASS);
    if (!newLoginOk) {
      throw new Error('Could not authenticate to SonarQube with admin password or SONAR_NEW_PASS.');
    }
    currentSonarPass = SONAR_NEW_PASS;
  }

  await page.goto(`${SONAR_URL}/account/security`, { waitUntil: 'domcontentloaded' });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const loginHeading = page.getByRole('heading', { name: /log in to sonarqube/i });
    const loginField = page.getByRole('textbox', { name: /^login$/i });
    const passwordField = page.getByRole('textbox', { name: /^password$/i });
    const loginVisible =
      (await loginHeading.isVisible().catch(() => false)) ||
      ((await loginField.isVisible().catch(() => false)) && (await passwordField.isVisible().catch(() => false)));

    if (!loginVisible) break;

    // UI login fallback (should be rare now that we do API login).
    await loginField.fill(SONAR_ADMIN_USER);
    await passwordField.fill(currentSonarPass);
    await page.getByRole('button', { name: /^log in$/i }).click();
    await page.waitForLoadState('networkidle');

    // Wait for login form to disappear (successful auth) or keep looping.
    await page.waitForTimeout(1000);
    if (!(await loginHeading.isVisible().catch(() => false))) {
      break;
    }

    // Retry by reloading the security page.
    await page.goto(`${SONAR_URL}/account/security`, { waitUntil: 'domcontentloaded' });
  }

  // Final guard: if we're still seeing login, stop early with a clear message.
  if (await page.getByRole('heading', { name: /log in to sonarqube/i }).isVisible().catch(() => false)) {
    throw new Error('SonarQube login still required on /account/security. Check SONAR_NEW_PASS in .env.');
  }

  // Some Sonar versions bounce you back to login after navigation; re-assert we're on the security page.
  await page.goto(`${SONAR_URL}/account/security`, { waitUntil: 'domcontentloaded' });
  if (await page.getByRole('heading', { name: /log in to sonarqube/i }).isVisible().catch(() => false)) {
    throw new Error('SonarQube unexpectedly returned to login after authentication while opening /account/security');
  }

  await ensureSonarProjectExistsUi(page);
  return currentSonarPass;
}

test('SDLC flow: Gitea setup -> repo+issue -> Jenkins seed+pipeline -> Nexus -> nginx -> close issue', async ({ page }: { page: Page }) => {
  // 0) Ensure Sonar project exists; skip token creation for now.
  const sonarPass = await loginAndEnsureSonarProject(page);

  // 1) Gitea initial setup (only if not already installed)
  await page.goto(`${GITEA_URL}/`, { waitUntil: 'domcontentloaded' });

  // Detect install page by heading or URL (new Gitea versions may not have form[action="/install"])
  const isInstall = 
    page.url().includes('/install') ||
    await page.getByRole('heading', { name: /initial configuration/i }).isVisible().catch(() => false) ||
    await page.locator('form[action="/install"]').first().isVisible().catch(() => false);
  if (isInstall) {
    // Wait for page to be fully loaded
    await page.waitForTimeout(2000);

    // Fill Site Title using role-based selector (matches accessibility tree)
    const siteTitleField = page.getByRole('textbox', { name: /site title/i });
    await siteTitleField.clear();
    await siteTitleField.fill('hello-world');

    // Scroll ALL THE WAY to the bottom of the page FIRST to reveal the Admin section
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Expand "Administrator Account Settings" section (collapsed by default)
    await page.getByText('Administrator Account Settings').click();
    await page.waitForTimeout(1000);

    // Admin account - fill fields using role-based selectors
    await page.getByRole('textbox', { name: /administrator username/i }).fill(GITEA_ADMIN_USER);
    await page.getByRole('textbox', { name: /^password$/i }).fill(GITEA_ADMIN_PASS);
    await page.getByRole('textbox', { name: /confirm password/i }).fill(GITEA_ADMIN_PASS);
    await page.getByRole('textbox', { name: /email address/i }).fill(GITEA_ADMIN_EMAIL);

    // Scroll to bottom again and click Install button
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: 'Install Gitea' }).click();

    // Wait for install to complete and redirect
    await page.waitForURL((url) => !url.toString().includes('/install'), { timeout: 120_000 });
    await page.waitForLoadState('networkidle');
  }

  // 2) Login and create repo
  await giteaLogin(page);

  // Check if repo already exists
  await page.goto(`${GITEA_URL}/${GITEA_ADMIN_USER}/${REPO}`, { waitUntil: 'domcontentloaded' });
  const repoExists = !page.url().includes('/repo/create') && 
    await page.getByText(REPO).first().isVisible().catch(() => false);

  if (!repoExists) {
    await page.goto(`${GITEA_URL}/repo/create`, { waitUntil: 'domcontentloaded' });
    // Repo name
    await page.getByLabel(/repository name/i).fill(REPO);
    // Default branch name if present
    const defaultBranch = page.getByLabel(/default branch/i);
    if (await defaultBranch.isVisible().catch(() => false)) {
      await defaultBranch.fill('main');
    }
    await page.getByRole('button', { name: /create repository/i }).click();
    // Wait for repo page to load
    await page.waitForURL((url) => url.toString().includes(`/${REPO}`), { timeout: 30_000 });
  }

  // 3) Create issue - navigate to Issues tab and click New Issue (skip if issue already exists)
  await page.goto(`${GITEA_URL}/${GITEA_ADMIN_USER}/${REPO}/issues`, { waitUntil: 'domcontentloaded' });
  const issueExists = await page.getByRole('link', { name: ISSUE_TITLE }).isVisible().catch(() => false);

  if (!issueExists) {
    await page.getByRole('link', { name: /new issue/i }).click();
    await page.waitForTimeout(1000);
    
    // Fill issue title and submit
    await page.getByRole('textbox', { name: /title/i }).fill(ISSUE_TITLE);
    await page.getByRole('button', { name: /create issue/i }).click();
    await page.waitForTimeout(2000);
  }

  // Go back to repo code view to add files
  await page.goto(`${GITEA_URL}/${GITEA_ADMIN_USER}/${REPO}`, { waitUntil: 'domcontentloaded' });

  // 4) Add files via web editor (skip if file already exists)
  async function addFile(filename: string, content: string) {
    // Check if file already exists
    await page.goto(`${GITEA_URL}/${GITEA_ADMIN_USER}/${REPO}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    // Check for file in the file list - look for exact text match
    const fileExists = await page.locator(`a.repo-file-name:has-text("${filename}"), td a:has-text("${filename}"), .repo-file-list a:has-text("${filename}")`).first().isVisible().catch(() => false) ||
      await page.getByText(filename, { exact: true }).first().isVisible().catch(() => false);
    if (fileExists) {
      console.log(`File ${filename} already exists, skipping creation`);
      return;
    }

    // Click "Add File" dropdown then "New File" option (new Gitea UI)
    await page.locator('button:has-text("Add File"), .ui.dropdown:has-text("Add File")').first().click();
    await page.waitForTimeout(500);
    await page.locator('a:has-text("New File"), .item:has-text("New File")').first().click();
    await page.waitForTimeout(2000);

    // Type filename in the input field
    await page.keyboard.type(filename);
    
    // Press Tab twice to jump to the editor body (first Tab goes to Cancel link)
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    
    // Type the content directly
    await page.keyboard.type(content);

    // Scroll down and commit the file
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /commit changes/i }).click();
    await page.waitForTimeout(3000);
  }

  // Simple index.html with hello world
  await addFile('index.html', '<html><body><h1>hello world</h1></body></html>');

  // Jenkinsfile for the pipeline - publishes to Nexus, deployer syncs to nginx
  // Use single line to avoid newline issues when typing
  await addFile('Jenkinsfile', "pipeline { agent any; stages { stage('Publish to Nexus') { steps { sh 'PASS=$(cat /nexus-data/admin.password) && curl -fsS -u admin:$PASS --upload-file index.html http://nexus:8081/repository/web/hello-world/index.html' } } } }");

  // 5) Jenkins: login, run seed-job with repo URL, then run generated pipeline
  await page.goto(`${JENKINS_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Fill username and password using input name attributes
  await page.locator('input[name="j_username"]').fill(JENKINS_ADMIN_USER);
  await page.locator('input[name="j_password"]').fill(JENKINS_ADMIN_PASS);
  await page.locator('button[name="Submit"], input[name="Submit"]').click();
  await page.waitForTimeout(3000);

  // Seed job parameters - navigate to build page
  await page.goto(`${JENKINS_URL}/job/seed-job/build`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Click Proceed if POST confirmation page appears (Jenkins requires POST for builds)
  const proceedBtn = page.getByRole('button', { name: /proceed/i });
  if (await proceedBtn.isVisible().catch(() => false)) {
    await proceedBtn.click();
    await page.waitForTimeout(3000);
  }
  
  // The form should already have default values from job config - just click Build
  await page.getByRole('button', { name: /build/i }).click();
  await page.waitForTimeout(5000);

  // Wait for hello-world job to appear
  await page.goto(`${JENKINS_URL}/`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: 'hello-world', exact: true })).toBeVisible({ timeout: 2 * 60 * 1000 });

  // Trigger pipeline build
  await page.goto(`${JENKINS_URL}/job/hello-world/build?delay=0sec`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  
  // Click Proceed if POST confirmation page appears
  const proceedBtn2 = page.getByRole('button', { name: /proceed/i });
  if (await proceedBtn2.isVisible().catch(() => false)) {
    await proceedBtn2.click();
  }

  // Wait for latest successful build - click on "Last successful build" link
  await page.goto(`${JENKINS_URL}/job/hello-world/`, { waitUntil: 'domcontentloaded' });
  
  // Wait for a successful build to appear (poll until we see "Last successful build")
  await expect(page.getByText(/last successful build/i)).toBeVisible({ timeout: 3 * 60 * 1000 });
  
  // Click on the last successful build link
  await page.getByRole('link', { name: /last successful build/i }).click();
  await page.waitForLoadState('domcontentloaded');
  
  // Verify we're on a successful build page
  await expect(page.locator('body')).toContainText(/success/i, { timeout: 30_000 });

  // 6) Verify artifact exists in Nexus (use API request since browser downloads the file)
  const nexusResponse = await page.request.get('http://localhost:8081/repository/web/hello-world/index.html');
  expect(nexusResponse.ok()).toBeTruthy();
  const nexusContent = await nexusResponse.text();
  expect(nexusContent).toContain('hello world');

  // 7) Verify nginx serves updated HTML (deployer syncs from Nexus)
  await page.goto(NGINX_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toHaveText('hello world', { timeout: 2 * 60 * 1000 });

  // 8) Close issue
  await page.goto(`${GITEA_URL}/${GITEA_ADMIN_USER}/${REPO}/issues`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: ISSUE_TITLE }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: /close issue/i }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('body')).toContainText(/closed/i);
});
