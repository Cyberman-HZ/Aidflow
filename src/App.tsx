// AidFlow Pro — Top-level router
// Screens listed in PDF Section 12 (UI/UX Design Specifications).

import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { applyDirection } from './i18n';
import { useSettingsStore } from './stores/settingsStore';
import { useAuthStore } from './stores/authStore';

import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Families from './pages/Families';
import FamilyDetail from './pages/FamilyDetail';
import Distribute from './pages/Distribute';
import Assistant from './pages/Assistant';
import KnowledgeBase from './pages/KnowledgeBase';
import KidsContent from './pages/KidsContent';
import AidGuides from './pages/AidGuides';
import StarlinkMap from './pages/StarlinkMap';
import Bitchat from './pages/Bitchat';
import Settings from './pages/Settings';
import Reports from './pages/Reports';

export default function App() {
  const { i18n } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const user = useAuthStore((s) => s.user);
  const location = useLocation();

  useEffect(() => {
    void i18n.changeLanguage(language);
    applyDirection(language);
  }, [language, i18n]);

  // Hide top route flicker for unauthenticated users
  useEffect(() => {
    document.title = `AidFlow Pro${location.pathname !== '/' ? ' — ' + location.pathname.replace(/^\//, '') : ''}`;
  }, [location.pathname]);

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/families" element={<Families />} />
        <Route path="/families/:id" element={<FamilyDetail />} />
        <Route path="/distribute" element={<Distribute />} />
        <Route path="/assistant" element={<Assistant />} />
        <Route path="/docs" element={<KnowledgeBase />} />
        <Route path="/kids" element={<KidsContent />} />
        <Route path="/guides" element={<AidGuides />} />
        <Route path="/map" element={<StarlinkMap />} />
        <Route path="/chat" element={<Bitchat />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/reports" element={<Reports />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
