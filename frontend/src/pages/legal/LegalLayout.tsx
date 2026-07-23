import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import mark from '../../assets/bankai-mark.svg';
import wordmark from '../../assets/bankai-wordmark.svg';
import LandingFooter from '../landing/LandingFooter';
import '../landing/Landing.css';
import './Legal.css';

interface LegalLayoutProps {
  kicker: string;
  title: string;
  updated: string;
  children: React.ReactNode;
}

// Shared frame for the legal pages: the landing page's visual language
// (tokens come from Landing.css via the .landing scope) with a simplified
// always-solid nav whose brand links back to the landing page.
export default function LegalLayout({ kicker, title, updated, children }: LegalLayoutProps) {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="landing">
      <header className="ldg-nav ldg-nav-scrolled">
        <div className="ldg-nav-inner">
          <Link to="/" className="ldg-nav-brand" aria-label="Bankai home">
            <img src={mark} alt="" className="ldg-brand-mark" />
            <img src={wordmark} alt="Bankai" className="ldg-brand-wordmark" />
          </Link>
          <div className="ldg-nav-actions">
            <Link to="/login" className="ldg-nav-login">
              Log in
            </Link>
            <Link to="/signup" className="ldg-btn-primary ldg-btn-nav">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main className="ldg-legal-main">
        <p className="ldg-legal-kicker">{kicker}</p>
        <h1 className="ldg-legal-title">{title}</h1>
        <p className="ldg-legal-updated">Last updated: {updated}</p>
        <div className="ldg-legal-body">{children}</div>
      </main>

      <LandingFooter />
    </div>
  );
}
