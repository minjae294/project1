import { useEffect, useState } from 'react';
import { AngleMatrixTable } from './components/AngleMatrixTable';
import { EmrRecordsView } from './components/EmrRecordsView';
import { NewBedModal } from './components/NewBedModal';
import { PrdViewer } from './components/PrdViewer';
import { WardBedWorkspace } from './components/WardBedWorkspace';
import {
  EmrNursingRecord,
  INITIAL_WARD_PATIENTS,
  normalizeCriticalAlertState,
  WardPatient,
} from './data/protocolData';

type WorkspaceTab = 'workspace' | 'matrix' | 'records' | 'prd';

const STORAGE_PATIENTS_KEY = 'sbpp_ward_patients_v3';
const STORAGE_RECORDS_KEY = 'sbpp_emr_records_v2';

export function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('workspace');
  const [isNewBedOpen, setIsNewBedOpen] = useState(false);

  const [patients, setPatients] = useState<WardPatient[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PATIENTS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((p: WardPatient) => {
            const tilt = p.inputs?.lateralTilt ?? 'center';
            const lastSide =
              p.lastSideTilt ?? (tilt === 'left_30' ? 'left_30' : 'right_30');
            const elapsed =
              typeof p.elapsedMinutes === 'number' && p.elapsedMinutes >= 0
                ? p.elapsedMinutes
                : 0;
            const rawStart =
              typeof p.repositionStartedAtElapsed === 'number'
                ? p.repositionStartedAtElapsed
                : 0;
            const safeStart = Math.max(0, Math.min(rawStart, elapsed));
            const safeMaintained = Math.max(0, elapsed - safeStart);
            return {
              ...p,
              elapsedMinutes: elapsed,
              repositionStartedAtElapsed: safeStart,
              minutesSinceReposition: safeMaintained,
              customRepositionIntervalMin: p.customRepositionIntervalMin ?? null,
              lastSideTilt: lastSide,
              repositionProposedForCycle: Boolean(p.repositionProposedForCycle),
              repositionHoldCount: p.repositionHoldCount ?? 0,
              repositionSnoozeMinutesLeft: p.repositionSnoozeMinutesLeft ?? 0,
              minutesAbove45:
                typeof p.minutesAbove45 === 'number' ? p.minutesAbove45 : 0,
              highAngleProposedForCycle: Boolean(p.highAngleProposedForCycle),
              criticalAlert: normalizeCriticalAlertState(p.criticalAlert),
            };
          });
        }
      }
    } catch {
      // Fallback to defaults
    }
    return INITIAL_WARD_PATIENTS;
  });

  const [selectedPatientId, setSelectedPatientId] = useState<string>(
    () => patients[0]?.id || INITIAL_WARD_PATIENTS[0].id
  );

  const [emrRecords, setEmrRecords] = useState<EmrNursingRecord[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_RECORDS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Fallback to empty
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PATIENTS_KEY, JSON.stringify(patients));
    } catch {
      // Storage quota ignored
    }
  }, [patients]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_RECORDS_KEY, JSON.stringify(emrRecords));
    } catch {
      // Storage quota ignored
    }
  }, [emrRecords]);

  const handleUpdatePatient = (updated: WardPatient) => {
    setPatients((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const handleCreatePatient = (newPatient: WardPatient) => {
    setPatients((prev) => [...prev, newPatient]);
    setSelectedPatientId(newPatient.id);
    setActiveTab('workspace');
  };

  const handleAddEmrRecord = (record: EmrNursingRecord) => {
    const withMs: EmrNursingRecord = {
      ...record,
      createdAtMs: record.createdAtMs ?? Date.now(),
    };
    setEmrRecords((prev) => {
      const idx = prev.findIndex((r) => r.id === withMs.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = withMs;
        return next;
      }
      return [withMs, ...prev];
    });
  };

  const handleResetAllToInitial = () => {
    setPatients(INITIAL_WARD_PATIENTS);
    setSelectedPatientId(INITIAL_WARD_PATIENTS[0].id);
    setEmrRecords((prev) => prev.filter((r) => !r.isPractice));
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* 3-Zone Top Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('workspace')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            스마트 침대 각도 관리
          </button>

          <nav className="flex items-center gap-6 text-sm font-medium overflow-x-auto" aria-label="주 메뉴">
            <button
              type="button"
              onClick={() => setActiveTab('workspace')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'workspace'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              침대 각도 조절
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('matrix')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'matrix'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              각도별 효과표
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('records')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'records'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              간호 기록함
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('prd')}
              className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'prd'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              기획서 (PRD)
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setIsNewBedOpen(true)}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              환자 추가
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-8">
        {activeTab === 'workspace' && (
          <WardBedWorkspace
            patients={patients}
            selectedPatientId={selectedPatientId}
            onSelectPatient={setSelectedPatientId}
            onUpdatePatient={handleUpdatePatient}
            onAddEmrRecord={handleAddEmrRecord}
            onResetAllToInitial={handleResetAllToInitial}
          />
        )}
        {activeTab === 'matrix' && <AngleMatrixTable />}
        {activeTab === 'records' && <EmrRecordsView records={emrRecords} />}
        {activeTab === 'prd' && <PrdViewer />}
      </main>

      <NewBedModal
        open={isNewBedOpen}
        onClose={() => setIsNewBedOpen(false)}
        onCreate={handleCreatePatient}
      />

      <footer className="bg-white border-t border-slate-200 mt-12">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-500">
          <div>
            스마트 침대 각도 관리 · 표시된 모든 환자와 생체 수치는 교육·테스트용 가상 데이터입니다
          </div>
          <div>실제 환자에게 적용할 때는 반드시 담당 간호사 확인 및 의료진 보고가 필요합니다</div>
        </div>
      </footer>
    </div>
  );
}

export default App;
