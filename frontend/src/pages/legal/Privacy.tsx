import { Link } from 'react-router-dom';
import LegalLayout from './LegalLayout';

const REPO_URL = 'https://github.com/anubhavgpta/bankai-security-remediation-platform';

export default function Privacy() {
  return (
    <LegalLayout kicker="Legal" title="Privacy Policy" updated="July 23, 2026">
      <h2>1. Overview</h2>
      <p>
        This Privacy Policy describes what data the hosted Bankai service collects, how it is
        used, and the choices you have. It applies to the hosted Service only — if you self-host
        Bankai from the{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          open-source repository
        </a>
        , your deployment&rsquo;s operator controls that instance&rsquo;s data practices. These practices
        should be read together with the <Link to="/terms">Terms of Service</Link>.
      </p>

      <h2>2. Data we collect</h2>
      <ul>
        <li>
          <strong>Account data.</strong> Your name, email address, and password (stored only as a
          hash by our authentication provider). If you sign in with Google or GitHub, we receive
          your basic profile information (name, email, avatar) from that provider.
        </li>
        <li>
          <strong>Project content.</strong> Scan reports you upload, security findings, tickets,
          remediation state, and project configuration.
        </li>
        <li>
          <strong>Repository data.</strong> When you connect GitHub, Bankai fetches repository
          contents as needed to scan for vulnerabilities and generate fixes. Repository code is
          processed transiently and is not stored as a copy in our database — only findings
          derived from it (file paths, line ranges, code excerpts as evidence) are persisted.
        </li>
        <li>
          <strong>Integration credentials.</strong> GitHub tokens, Jira API tokens, and webhook
          secrets you provide. These are encrypted before being persisted.
        </li>
        <li>
          <strong>Activity data.</strong> An append-only activity log of state changes in your
          projects (who did what, when), used for auditability inside your workspace.
        </li>
        <li>
          <strong>Technical data.</strong> IP addresses and request metadata processed for
          security purposes — rate limiting, bot detection, and abuse prevention. Bankai does not
          use advertising trackers or analytics cookies.
        </li>
      </ul>

      <h2>3. How we use data</h2>
      <ul>
        <li>To operate the Service: triage findings, create tickets, and open fix pull requests.</li>
        <li>To synchronize tickets with integrations you connect (GitHub, Jira).</li>
        <li>To secure the Service: authentication, session management, and abuse prevention.</li>
        <li>To send transactional emails (account confirmation, password reset, invitations).</li>
      </ul>
      <p>We do not sell your data or use it for advertising.</p>

      <h2>4. AI processing</h2>
      <p>
        Bankai uses Google&rsquo;s Gemini API to analyze findings and generate fix proposals. When a
        scan or fix generation runs, relevant material — the finding&rsquo;s details and the affected
        file&rsquo;s contents, along with limited surrounding repository context — is transmitted to
        Google for processing. This happens only for repositories you have explicitly connected,
        and only in the course of features you invoke. AI output is stored as part of your project
        content (findings, fix summaries, pull request text).
      </p>

      <h2>5. Subprocessors</h2>
      <p>The hosted Service runs on the following infrastructure providers:</p>
      <ul>
        <li>
          <strong>Supabase</strong> — database, authentication, and transactional email delivery.
        </li>
        <li>
          <strong>Railway</strong> — application hosting for the backend and background workers.
        </li>
        <li>
          <strong>Google (Gemini API)</strong> — AI analysis and fix generation, as described
          above.
        </li>
        <li>
          <strong>Arcjet</strong> — web application firewall, bot detection, and rate limiting
          (processes request metadata including IP addresses).
        </li>
        <li>
          <strong>GitHub and Atlassian (Jira)</strong> — only when you connect them, under your
          own accounts and their own privacy policies.
        </li>
      </ul>

      <h2>6. Cookies</h2>
      <p>
        Bankai uses only essential cookies: httpOnly session cookies that keep you signed in.
        There are no third-party, analytics, or advertising cookies.
      </p>

      <h2>7. Security</h2>
      <p>
        Security measures include row-level security as the primary data boundary between
        projects, encryption of integration secrets at rest, httpOnly cookie sessions with
        server-side revocation, HMAC-verified webhooks, and CSRF and origin checks on
        state-changing requests. No system is perfectly secure, but Bankai&rsquo;s own security posture
        is treated as part of the product.
      </p>

      <h2>8. Data retention and deletion</h2>
      <p>
        Your data is retained while your account and projects exist. Deleting a project removes
        its findings, tickets, and integration credentials; deleting your account removes your
        personal data from the Service. Encrypted backups held by our infrastructure providers
        expire on their standard schedules.
      </p>

      <h2>9. Your rights</h2>
      <p>
        You can access and update your account information in Account Settings, disconnect
        integrations at any time, and delete projects or your account. Depending on where you
        live, you may have additional legal rights (such as access, correction, portability, or
        erasure) — contact us via the repository below to exercise them.
      </p>

      <h2>10. Changes to this policy</h2>
      <p>
        We may update this policy from time to time. The &ldquo;Last updated&rdquo; date above reflects the
        most recent revision; material changes will be visible on this page.
      </p>

      <h2>11. Contact</h2>
      <p>
        Privacy questions and requests can be raised on the{' '}
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
          Bankai GitHub repository
        </a>
        .
      </p>
    </LegalLayout>
  );
}
