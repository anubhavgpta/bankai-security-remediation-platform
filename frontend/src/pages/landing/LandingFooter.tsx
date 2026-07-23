import { Link } from 'react-router-dom';
import wordmark from '../../assets/bankai-wordmark.svg';

export default function LandingFooter() {
  return (
    <footer className="ldg-footer">
      <div className="ldg-footer-inner">
        <div className="ldg-footer-brand">
          <img src={wordmark} alt="Bankai" className="ldg-footer-wordmark" />
          <p className="ldg-footer-tag">
            Vulnerability remediation, closed-loop: from scan output to CI-verified pull requests.
          </p>
        </div>

        <nav className="ldg-footer-col" aria-label="Product">
          <h3 className="ldg-footer-head">Product</h3>
          <a href="#pipeline">Pipeline</a>
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#faq">FAQ</a>
        </nav>

        <nav className="ldg-footer-col" aria-label="Account">
          <h3 className="ldg-footer-head">Account</h3>
          <Link to="/signup">Sign up</Link>
          <Link to="/login">Log in</Link>
          <Link to="/forgot-password">Reset password</Link>
        </nav>

        <nav className="ldg-footer-col" aria-label="Legal">
          <h3 className="ldg-footer-head">Legal</h3>
          <Link to="/terms">Terms of Service</Link>
          <Link to="/privacy">Privacy Policy</Link>
        </nav>

        <nav className="ldg-footer-col" aria-label="Open source">
          <h3 className="ldg-footer-head">Open source</h3>
          <a
            href="https://github.com/anubhavgpta/bankai-security-remediation-platform"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://github.com/anubhavgpta/bankai-security-remediation-platform/blob/main/README.md"
            target="_blank"
            rel="noreferrer"
          >
            Documentation
          </a>
          <a
            href="https://github.com/anubhavgpta/bankai-security-remediation-platform/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            MIT License
          </a>
        </nav>
      </div>
      <p className="ldg-footer-fine">Bankai is open source under the MIT License.</p>
    </footer>
  );
}
