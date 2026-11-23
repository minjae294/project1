import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FastForward,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  areVitalsRelaxedSafe,
  checkAngleAppropriateness,
  CriticalAlertState,
  CriticalEpisodeTimelineEntry,
  CriticalRiskCategory,
  DEFAULT_CRITICAL_ALERT_STATE,
  EmrNursingRecord,
  evaluateBedAngleProtocol,
  evaluatePatientVitalStatus,
  formatCriticalCategoryKo,
  formatRepositionAgoLabel,
  formatTiltKo,
  getCriticalRiskCategories,
  getDefaultRepositionInterval,
  getNextCycleTilt,
  HIGH_ANGLE_HOB_THRESHOLD,
  HIGH_ANGLE_LIMIT_MINUTES,
  LateralTiltPosition,
  normalizeCriticalAlertState,
  PatientInputs,
  PracticeScenarioPreset,
  SacralSkinStatus,
  simulateVitalsAtAngle,
  WardPatient,
} from '../data/protocolData';
import { BedAngleVisualizer } from './BedAngleVisualizer';
import { PracticeToolsDrawer } from './PracticeToolsDrawer';
import { VitalTrendChart } from './VitalTrendChart';

interface WardBedWorkspaceProps {
  patients: WardPatient[];
  selectedPatientId: string;
  onSelectPatient: (id: string) => void;
  onUpdatePatient: (updated: WardPatient) => void;
  onAddEmrRecord: (record: EmrNursingRecord) => void;
  onResetAllToInitial: () => void;
}

interface TimeEventLog {
  id: string;
  proposalKey?: string;
  elapsedLabel: string;
  type: 'proposal' | 'confirmed' | 'critical' | 'pressure';
  message: string;
}

type HoldChipReason = '환자 수면' | '처치 중' | '의료진 지시' | '기타';

interface QueuedAlert {
  id: string;
  patient: WardPatient;
  category: 'critical' | 'respiratory' | 'reposition';
  tierScore: number; // 낮을수록 더 급함
  title: string;
  summary: string;
  actionLabel?: string;
  canHoldReposition?: boolean;
  isCriticalRepositionOverride?: boolean;
  isCriticalDelayedNotice?: boolean;
  targetAngle?: number;
  targetRevTilt?: number;
  targetKnee?: number;
  targetTilt?: LateralTiltPosition;
  angleKey?: string;
  criticalStage?: CriticalAlertState['stage'];
}

const QUICK_ANGLES = [0, 15, 30, 45, 60, 75, 90];
const HOLD_CHIPS: HoldChipReason[] = ['환자 수면', '처치 중', '의료진 지시', '기타'];
const BASE_CLOCK_MINUTES = 18 * 60 + 20;

const formatTiltActionKo = (tilt: LateralTiltPosition) =>
  tilt === 'center'
    ? '정면으로 돌리기'
    : tilt === 'left_30'
      ? '왼쪽 30° 돌리기'
      : '오른쪽 30° 돌리기';

export const WardBedWorkspace: React.FC<WardBedWorkspaceProps> = ({
  patients,
  selectedPatientId,
  onSelectPatient,
  onUpdatePatient,
  onAddEmrRecord,
  onResetAllToInitial,
}) => {
  const activePatient = patients.find((p) => p.id === selectedPatientId) || patients[0];
  const inputs = activePatient.inputs;

  // 누적 경과 시간 및 자세 유지 시간의 단일 기준 (유지 시간 <= 누적 경과 시간)
  const elapsedMinutes = Math.max(0, activePatient.elapsedMinutes ?? 0);
  const repositionStartedAtElapsed = Math.max(
    0,
    Math.min(activePatient.repositionStartedAtElapsed ?? 0, elapsedMinutes)
  );
  const currentRepositionMinutes = Math.max(0, elapsedMinutes - repositionStartedAtElapsed);

  const activeVitalStatus = useMemo(() => evaluatePatientVitalStatus(inputs), [inputs]);
  const recommendedForPatient = useMemo(() => evaluateBedAngleProtocol(inputs), [inputs]);
  const mapValue = Math.round((inputs.sbp + 2 * inputs.dbp) / 3);
  const hasPressureRisk =
    inputs.pressureInjuryHighRisk || inputs.sacralSkinStatus !== 'intact';

  // 선택/조절 중인 목표 각도 (기본은 추천 각도)
  const [plannedHobInput, setPlannedHobInput] = useState<number>(
    recommendedForPatient.recommendedHob
  );
  const [virtualMode, setVirtualMode] = useState<boolean>(true);
  const [criticalApplyConfirmed, setCriticalApplyConfirmed] = useState<boolean>(false);

  // 위험 대응 및 재측정 입력 상태
  const [doctorNotified, setDoctorNotified] = useState<boolean>(false);
  const [orderNoteInput, setOrderNoteInput] = useState<string>(
    '산소 유량 확인 및 처치 시행, 15분 간격 경과 관찰'
  );
  const [orderHobInput, setOrderHobInput] = useState<number | null>(null);
  const [recheckInputs, setRecheckInputs] = useState<{ rr: number; hr: number; spo2: number }>({
    rr: inputs.rr,
    hr: inputs.hr,
    spo2: inputs.spo2,
  });
  const [recheckPanelOpen, setRecheckPanelOpen] = useState<boolean>(false);

  // 보류 칩 상태 · 알림 목록 펼치기 · 상단 알림 위험체위 확인 체크
  const [holdTargetPatientId, setHoldTargetPatientId] = useState<string | null>(null);
  const [customHoldReason, setCustomHoldReason] = useState<string>('');
  const [alertStackOpen, setAlertStackOpen] = useState<boolean>(false);
  const [stickyCriticalTiltChecked, setStickyCriticalTiltChecked] = useState<boolean>(false);
  const [acknowledgedAngleKeys, setAcknowledgedAngleKeys] = useState<Record<string, string>>({});

  // 돌아눕기 위험 확인 상태
  const [pendingLateralTilt, setPendingLateralTilt] = useState<LateralTiltPosition | null>(null);
  const [pendingLateralSafetyChecked, setPendingLateralSafetyChecked] = useState<boolean>(false);

  // 접이식 영역 (그래프·그림 보기 / 자세히 보기·더보기) & 초기화 확인 창
  const [showVisuals, setShowVisuals] = useState<boolean>(false);
  const [showMoreDetails, setShowMoreDetails] = useState<boolean>(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState<boolean>(false);

  // 상단 알림 바 높이 측정 (시뮬레이션 바를 알림 바 바로 아래에 겹치지 않게 고정)
  const alertBarRef = useRef<HTMLDivElement | null>(null);
  const [alertBarHeight, setAlertBarHeight] = useState<number>(64);

  useEffect(() => {
    const el = alertBarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateHeight = () => setAlertBarHeight(el.offsetHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 시간 시뮬레이션 & 시연 상태
  const [timeFlowPlaying, setTimeFlowPlaying] = useState<boolean>(false);
  const [timeSpeed, setTimeSpeed] = useState<1 | 10 | 60>(10);
  const [stoppedByAlertNotice, setStoppedByAlertNotice] = useState<boolean>(false);
  const [lastSimRecoveryBadge, setLastSimRecoveryBadge] = useState<string | null>(null);
  const [timeEvents, setTimeEvents] = useState<TimeEventLog[]>([]);

  // 3초 토스트 알림
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const rec = evaluateBedAngleProtocol(activePatient.inputs);
    setPlannedHobInput(rec.recommendedHob);
    setCriticalApplyConfirmed(false);
    setDoctorNotified(false);
    setPendingLateralTilt(null);
    setPendingLateralSafetyChecked(false);
    setOrderHobInput(null);
    setLastSimRecoveryBadge(null);
    setTimeFlowPlaying(false);
    setStoppedByAlertNotice(false);
    setStickyCriticalTiltChecked(false);
    setHoldTargetPatientId(null);
    setRecheckInputs({
      rr: activePatient.inputs.rr,
      hr: activePatient.inputs.hr,
      spo2: activePatient.inputs.spo2,
    });
  }, [activePatient.id]);

  // 추천 각도가 수동 수치 조정으로 바뀔 때 목표 각도 동기화
  useEffect(() => {
    setPlannedHobInput(recommendedForPatient.recommendedHob);
  }, [recommendedForPatient.recommendedHob]);

  const liveDecision = useMemo(
    () => evaluateBedAngleProtocol({ ...inputs, currentHob: plannedHobInput }),
    [inputs, plannedHobInput]
  );

  // 현재 환자 위험 흐름 상태
  const storedCriticalAlert: CriticalAlertState = normalizeCriticalAlertState(
    activePatient.criticalAlert
  );
  const currentCriticalCats = useMemo(() => getCriticalRiskCategories(inputs), [inputs]);
  const effectiveCriticalAlert: CriticalAlertState =
    activeVitalStatus.level === 'critical' && storedCriticalAlert.stage === 'idle'
      ? {
          ...storedCriticalAlert,
          stage: 'alert_required',
          episodeId: storedCriticalAlert.episodeId ?? `crit-${activePatient.id}-${elapsedMinutes}`,
          episodeRiskCategories: currentCriticalCats,
        }
      : storedCriticalAlert;

  // '호전 시 종료'(resolved)에 도달하면 확인 버튼 전이라도 즉시 체위변경 알림 숨김 해제
  const isCriticalPriorityActive =
    effectiveCriticalAlert.stage !== 'resolved' &&
    (effectiveCriticalAlert.stage === 'alert_required' ||
      effectiveCriticalAlert.stage === 'awaiting_order' ||
      effectiveCriticalAlert.stage === 'observing' ||
      effectiveCriticalAlert.stage === 'continuous_observation' ||
      activeVitalStatus.level === 'critical');

  const criticalDoctorNotified =
    effectiveCriticalAlert.stage === 'awaiting_order' ||
    effectiveCriticalAlert.stage === 'observing' ||
    effectiveCriticalAlert.stage === 'continuous_observation' ||
    effectiveCriticalAlert.stage === 'resolved' ||
    doctorNotified;

  // 현재 환자 체위변경 계산
  const defaultRepositionInterval = getDefaultRepositionInterval(inputs);
  const repositionIntervalMinutes =
    activePatient.customRepositionIntervalMin ?? defaultRepositionInterval;
  const isCustomRepositionInterval = activePatient.customRepositionIntervalMin != null;
  const nextCycleTilt = getNextCycleTilt(
    inputs.lateralTilt,
    activePatient.lastSideTilt ?? 'right_30'
  );
  const remainingToReposition = Math.max(0, repositionIntervalMinutes - currentRepositionMinutes);
  const overdueMinutes = Math.max(0, currentRepositionMinutes - repositionIntervalMinutes);
  const severeRepositionThreshold = Math.round(repositionIntervalMinutes * 1.5);
  const isSevereRepositionOverride = currentRepositionMinutes >= severeRepositionThreshold;
  const repositionHoldCount = activePatient.repositionHoldCount ?? 0;
  const repositionSnoozeLeft = activePatient.repositionSnoozeMinutesLeft ?? 0;
  const repositionAlertDue =
    (!isCriticalPriorityActive || isSevereRepositionOverride) &&
    currentRepositionMinutes >= repositionIntervalMinutes &&
    repositionSnoozeLeft === 0;
  const repeatedHoldWarning =
    (!isCriticalPriorityActive || isSevereRepositionOverride) && repositionHoldCount >= 3;

  const minutesAbove45 = activePatient.minutesAbove45 ?? 0;
  const highAnglePressureAlertDue =
    !isCriticalPriorityActive &&
    inputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD &&
    minutesAbove45 >= HIGH_ANGLE_LIMIT_MINUTES;

  const activeRuleConflicts = recommendedForPatient.ruleConflicts;

  // 포맷 도우미
  const formatElapsed = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}시간 ${String(m).padStart(2, '0')}분`;
  };

  const makeTimestamp = () =>
    new Date().toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

  const formatClockFromElapsed = (mins: number) => {
    const total = (BASE_CLOCK_MINUTES + mins) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };

  const formatClockKorFromElapsed = (mins: number) => {
    const total = (BASE_CLOCK_MINUTES + mins) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}시 ${String(m).padStart(2, '0')}분`;
  };

  const getNextUniqueElapsedFor = (pt: WardPatient, minDelta: number) => {
    const ptElapsed = Math.max(0, pt.elapsedMinutes ?? 0);
    let candidate = ptElapsed + Math.max(1, minDelta);
    const lastLabel = pt.history[pt.history.length - 1]?.timeLabel;
    if (lastLabel && formatClockFromElapsed(candidate) === lastLabel) {
      candidate += 1;
    }
    return candidate;
  };

  const upsertCriticalEpisodeEmrFor = (
    pt: WardPatient,
    epState: CriticalAlertState,
    opts: {
      preInputs: PatientInputs;
      latestInputs: PatientInputs;
      prevHob: number;
      appliedHob: number;
      statusLabel: string;
      verdict: string;
      isPractice?: boolean;
    }
  ) => {
    const ptElapsed = Math.max(0, pt.elapsedMinutes ?? 0);
    const epId = epState.episodeId ?? `crit-${pt.id}-${Date.now()}`;
    const firstAlertEntry = epState.timeline[0];
    onAddEmrRecord({
      id: epId,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      isPractice: opts.isPractice || undefined,
      bedNumber: pt.bedNumber,
      patientName: pt.patientName,
      prevHob: opts.prevHob,
      appliedHob: opts.appliedHob,
      kneeGatch: opts.appliedHob > 30 ? 12 : 0,
      revTilt: 0,
      lateralTilt: opts.latestInputs.lateralTilt,
      preVitals: {
        rr: opts.preInputs.rr,
        hr: opts.preInputs.hr,
        spo2: opts.preInputs.spo2,
        bp: `${opts.preInputs.sbp}/${opts.preInputs.dbp}`,
      },
      postVitals:
        epState.timeline.length > 1
          ? {
              rr: opts.latestInputs.rr,
              hr: opts.latestInputs.hr,
              spo2: opts.latestInputs.spo2,
              bp: `${opts.latestInputs.sbp}/${opts.latestInputs.dbp}`,
            }
          : undefined,
      stabilizationMinutes: 0,
      criticalEpisodeMeta: {
        episodeId: epId,
        startedClock:
          epState.episodeStartedClock ??
          firstAlertEntry?.clockLabel ??
          formatClockKorFromElapsed(ptElapsed),
        statusLabel: opts.statusLabel,
        riskCategories: epState.episodeRiskCategories,
        doctorOrderNote: epState.doctorOrderNote,
        doctorOrderedHob: epState.doctorOrderedHob,
        noImprovementCount: epState.noImprovementCount,
        consecutiveSafeRechecks: epState.consecutiveSafeRechecks,
        seniorEscalationShown: epState.seniorEscalationShown,
        timeline: epState.timeline,
      },
      verdict: opts.verdict,
    });
  };

  const upsertRepositionDelayEmrFor = (
    pt: WardPatient,
    startedAt: number,
    maintainedMinutes: number,
    intervalMinutes: number,
    latestInputs: PatientInputs,
    isCriticalContext: boolean,
    isPractice?: boolean
  ) => {
    const delayMinutes = Math.max(0, maintainedMinutes - intervalMinutes);
    if (delayMinutes <= 0) return;
    const knee =
      latestInputs.currentHob > 30
        ? latestInputs.pressureInjuryHighRisk || latestInputs.sacralSkinStatus !== 'intact'
          ? 15
          : 12
        : 0;
    onAddEmrRecord({
      id: `reposition-delay-${pt.id}-${startedAt}`,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      isPractice: isPractice || undefined,
      bedNumber: pt.bedNumber,
      patientName: pt.patientName,
      prevHob: latestInputs.currentHob,
      appliedHob: latestInputs.currentHob,
      kneeGatch: knee,
      revTilt: 0,
      lateralTilt: latestInputs.lateralTilt,
      preVitals: {
        rr: latestInputs.rr,
        hr: latestInputs.hr,
        spo2: latestInputs.spo2,
        bp: `${latestInputs.sbp}/${latestInputs.dbp}`,
      },
      stabilizationMinutes: 0,
      repositionMeta: {
        prevTilt: latestInputs.lateralTilt,
        newTilt: latestInputs.lateralTilt,
        maintainedMinutes,
        isHold: false,
        isDelay: true,
        delayMinutes,
      },
      verdict: `[체위변경 지연 ${delayMinutes}분] ${formatTiltKo(
        latestInputs.lateralTilt
      )} ${maintainedMinutes}분 유지 (기준 ${intervalMinutes}분)${
        isCriticalContext ? ' · 의료진 확인 후 처리 필요' : ''
      }`,
    });
  };

  // 1단계: 위험 발생 -> 의료진에게 알리기
  const handleNotifyDoctorCritical = (
    targetPatient: WardPatient = activePatient,
    isPractice?: boolean
  ) => {
    const targetInputs = targetPatient.inputs;
    const useElapsed = Math.max(0, targetPatient.elapsedMinutes ?? 0);
    const clockKor = formatClockKorFromElapsed(useElapsed);
    const elapsedLabel = `+${formatElapsed(useElapsed)} (${formatClockFromElapsed(useElapsed)})`;
    const curCrit = normalizeCriticalAlertState(targetPatient.criticalAlert);
    const epId = curCrit.episodeId ?? `crit-${targetPatient.id}-${Date.now()}`;
    const detectedCats = getCriticalRiskCategories(targetInputs);
    const mergedCats: CriticalRiskCategory[] = Array.from(
      new Set([...curCrit.episodeRiskCategories, ...detectedCats])
    );
    const vitalSummary = evaluatePatientVitalStatus(targetInputs).reasons.join(', ');
    const vitalSnapStr = `호흡 ${targetInputs.rr} · 맥박 ${targetInputs.hr} · 산소 ${targetInputs.spo2}% · 혈압 ${targetInputs.sbp}/${targetInputs.dbp}`;
    const isNewCategoryAlert = Boolean(curCrit.newCategoryAlertNote) && curCrit.timeline.length > 0;

    const alertStep: CriticalEpisodeTimelineEntry = {
      id: `step-alert-${Date.now()}`,
      stepType: 'alert',
      clockLabel: clockKor,
      title: isNewCategoryAlert ? '새 위험 항목 알림 완료' : '의료진 알림 완료',
      detail: isNewCategoryAlert
        ? `${curCrit.newCategoryAlertNote} (${vitalSummary})`
        : `위험 항목(${mergedCats.map(formatCriticalCategoryKo).join(', ') || '위험 수치'}) 보고`,
      vitalsSummary: vitalSnapStr,
    };

    const nextStage =
      isNewCategoryAlert && curCrit.doctorOrderNote ? 'observing' : 'awaiting_order';

    const nextCritState: CriticalAlertState = {
      ...curCrit,
      stage: nextStage,
      episodeId: epId,
      episodeStartedClock: curCrit.episodeStartedClock ?? clockKor,
      alertedAtClock: clockKor,
      episodeRiskCategories: mergedCats,
      notifiedSnapshot: curCrit.notifiedSnapshot ?? {
        rr: targetInputs.rr,
        hr: targetInputs.hr,
        spo2: targetInputs.spo2,
        sbp: targetInputs.sbp,
        dbp: targetInputs.dbp,
      },
      newCategoryAlertNote: undefined,
      timeline: [...curCrit.timeline, alertStep],
    };

    if (targetPatient.id === activePatient.id) {
      setDoctorNotified(true);
      setRecheckInputs({
        rr: targetInputs.rr,
        hr: targetInputs.hr,
        spo2: targetInputs.spo2,
      });
      setOrderHobInput(null);
    }

    onUpdatePatient({
      ...targetPatient,
      criticalAlert: nextCritState,
    });

    const alertLogKey = `${epId}-alert`;
    const alertMsg = `${targetPatient.bedNumber} ${clockKor} 의료진 알림 완료 → ${
      nextStage === 'awaiting_order' ? '지시·처치 입력 대기' : '처치 중 관찰'
    }`;
    setTimeEvents((prev) =>
      [
        {
          id: `t-crit-alert-${Date.now()}`,
          proposalKey: alertLogKey,
          elapsedLabel,
          type: 'critical' as const,
          message: alertMsg,
        },
        ...prev.filter((e) => e.proposalKey !== alertLogKey),
      ].slice(0, 8)
    );

    upsertCriticalEpisodeEmrFor(targetPatient, nextCritState, {
      preInputs: targetInputs,
      latestInputs: targetInputs,
      prevHob: targetInputs.currentHob,
      appliedHob: targetInputs.currentHob,
      statusLabel: nextStage === 'awaiting_order' ? '지시 입력 대기' : '처치 중 관찰',
      verdict: `[1. 의료진 알림 완료 · ${clockKor}] ${vitalSummary}`,
      isPractice,
    });

    showToast(`${targetPatient.bedNumber} ${targetPatient.patientName} · 의료진 알림 완료 및 기록 저장됨`);
  };

  // 2단계: 의료진 지시·처치 입력 저장
  const handleSubmitDoctorOrder = (isPractice?: boolean) => {
    const curCrit = normalizeCriticalAlertState(activePatient.criticalAlert);
    const note = orderNoteInput.trim() || '의료진 처치 시행 및 경과 관찰';
    const nextElapsed = getNextUniqueElapsedFor(activePatient, 1);
    const nextMaintained = Math.max(0, nextElapsed - repositionStartedAtElapsed);
    const clockKor = formatClockKorFromElapsed(nextElapsed);
    const elapsedLabel = `+${formatElapsed(nextElapsed)} (${formatClockFromElapsed(nextElapsed)})`;
    const epId = curCrit.episodeId ?? `crit-${activePatient.id}-${nextElapsed}`;
    const targetHob = orderHobInput !== null ? orderHobInput : inputs.currentHob;
    const hobDesc =
      orderHobInput !== null && orderHobInput !== inputs.currentHob
        ? `각도 ${inputs.currentHob}° → ${orderHobInput}° 조절`
        : `현재 각도 ${inputs.currentHob}° 유지`;

    const orderStep: CriticalEpisodeTimelineEntry = {
      id: `step-order-${Date.now()}`,
      stepType: 'order',
      clockLabel: clockKor,
      title: '의료진 지시·처치 입력',
      detail: `${note} (${hobDesc})`,
      vitalsSummary: `호흡 ${inputs.rr} · 맥박 ${inputs.hr} · 산소 ${inputs.spo2}%`,
    };

    const nextInputs: PatientInputs = { ...inputs, currentHob: targetHob };
    const nextCritState: CriticalAlertState = {
      ...curCrit,
      stage: 'observing',
      episodeId: epId,
      orderEnteredAtClock: clockKor,
      doctorOrderNote: note,
      doctorOrderedHob: orderHobInput,
      timeline: [...curCrit.timeline, orderStep],
    };

    setPlannedHobInput(targetHob);
    setRecheckInputs({ rr: inputs.rr, hr: inputs.hr, spo2: inputs.spo2 });
    setRecheckPanelOpen(true);

    onUpdatePatient({
      ...activePatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed,
      minutesSinceReposition: nextMaintained,
      lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, inputs.lateralTilt),
      criticalAlert: nextCritState,
      minutesAbove45: targetHob > HIGH_ANGLE_HOB_THRESHOLD ? activePatient.minutesAbove45 : 0,
      highAngleProposedForCycle:
        targetHob > HIGH_ANGLE_HOB_THRESHOLD ? activePatient.highAngleProposedForCycle : false,
      inputs: nextInputs,
      history:
        orderHobInput !== null && orderHobInput !== inputs.currentHob
          ? [
              ...activePatient.history.slice(-7),
              {
                timeLabel: formatClockFromElapsed(nextElapsed),
                rr: inputs.rr,
                hr: inputs.hr,
                hob: targetHob,
                spo2: inputs.spo2,
                eventType: 'confirmed',
                eventLabel: `지시 ${targetHob}°`,
              },
            ]
          : activePatient.history,
    });

    setTimeEvents((prev) =>
      [
        {
          id: `t-crit-order-${Date.now()}`,
          proposalKey: `${epId}-order`,
          elapsedLabel,
          type: 'confirmed' as const,
          message: `의료진 지시 입력(${hobDesc}): ${note}`,
        },
        ...prev.filter((e) => e.proposalKey !== `${epId}-order`),
      ].slice(0, 8)
    );

    const snapPre = curCrit.notifiedSnapshot ? { ...inputs, ...curCrit.notifiedSnapshot } : inputs;
    upsertCriticalEpisodeEmrFor(activePatient, nextCritState, {
      preInputs: snapPre,
      latestInputs: nextInputs,
      prevHob: inputs.currentHob,
      appliedHob: targetHob,
      statusLabel: '처치 중 관찰',
      verdict: `[2. 지시 입력 → 처치 중 관찰] ${note} (${hobDesc})`,
      isPractice,
    });

    showToast(`${activePatient.bedNumber} · 의료진 지시 저장 및 처치 중 관찰 시작`);
  };

  // 3단계: 재측정 입력 또는 변화 없음 기록
  const handleSubmitCriticalRecheck = (
    mode: 'manual' | 'unchanged',
    isPractice?: boolean
  ) => {
    const curCrit = normalizeCriticalAlertState(activePatient.criticalAlert);
    const snap = curCrit.notifiedSnapshot ?? {
      rr: inputs.rr,
      hr: inputs.hr,
      spo2: inputs.spo2,
      sbp: inputs.sbp,
      dbp: inputs.dbp,
    };

    const nextElapsed = getNextUniqueElapsedFor(activePatient, 1);
    const nextMaintained = Math.max(0, nextElapsed - repositionStartedAtElapsed);
    const clockKor = formatClockKorFromElapsed(nextElapsed);
    const elapsedLabel = `+${formatElapsed(nextElapsed)} (${formatClockFromElapsed(nextElapsed)})`;
    const epId = curCrit.episodeId ?? `crit-${activePatient.id}-${nextElapsed}`;
    const preFull: PatientInputs = { ...inputs, ...snap };

    if (mode === 'unchanged') {
      const sameVitalsStr = `호흡 ${snap.rr}회 · 맥박 ${snap.hr}회 · 산소 ${snap.spo2}%`;
      const unchangedStep: CriticalEpisodeTimelineEntry = {
        id: `step-recheck-${Date.now()}`,
        stepType: 'recheck',
        clockLabel: clockKor,
        title: '재측정 (변화 없음)',
        detail: '이전 수치와 동일 · 새 알림 없이 관찰 유지',
        vitalsSummary: sameVitalsStr,
      };
      const nextCritState: CriticalAlertState = {
        ...curCrit,
        lastRecheckAtClock: clockKor,
        lastOutcome: 'unchanged',
        lastOutcomeDetail: `변화 없음 (${sameVitalsStr})`,
        timeline: [...curCrit.timeline, unchangedStep],
      };
      setRecheckInputs({ rr: snap.rr, hr: snap.hr, spo2: snap.spo2 });
      onUpdatePatient({
        ...activePatient,
        elapsedMinutes: nextElapsed,
        repositionStartedAtElapsed,
        minutesSinceReposition: nextMaintained,
        lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, inputs.lateralTilt),
        criticalAlert: nextCritState,
      });

      const statusLbl =
        nextCritState.stage === 'continuous_observation' ? '지시 대기·지속 관찰' : '처치 중 관찰';
      upsertCriticalEpisodeEmrFor(activePatient, nextCritState, {
        preInputs: preFull,
        latestInputs: inputs,
        prevHob: inputs.currentHob,
        appliedHob: inputs.currentHob,
        statusLabel: statusLbl,
        verdict: `[${statusLbl}] 재측정 변화 없음 (${sameVitalsStr})`,
        isPractice,
      });
      showToast(`${activePatient.bedNumber} · 재측정(변화 없음) 기록 완료`);
      return;
    }

    const recheckedInputs: PatientInputs = {
      ...inputs,
      rr: recheckInputs.rr,
      hr: recheckInputs.hr,
      spo2: recheckInputs.spo2,
    };

    // 위험 에피소드가 idle/resolved 상태에서 일반 재측정을 누른 경우
    if (curCrit.stage === 'idle' || curCrit.stage === 'resolved') {
      const nextCritCats = getCriticalRiskCategories(recheckedInputs);
      const nextSt = evaluatePatientVitalStatus(recheckedInputs);
      const isCrit = nextSt.level === 'critical';
      const nextCritState: CriticalAlertState = isCrit
        ? {
            ...DEFAULT_CRITICAL_ALERT_STATE,
            stage: 'alert_required',
            episodeId: `crit-${activePatient.id}-${nextElapsed}`,
            episodeStartedClock: clockKor,
            episodeRiskCategories: nextCritCats,
          }
        : DEFAULT_CRITICAL_ALERT_STATE;

      onUpdatePatient({
        ...activePatient,
        elapsedMinutes: nextElapsed,
        repositionStartedAtElapsed,
        minutesSinceReposition: nextMaintained,
        lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, inputs.lateralTilt),
        criticalAlert: nextCritState,
        inputs: recheckedInputs,
        history: [
          ...activePatient.history.slice(-7),
          {
            timeLabel: formatClockFromElapsed(nextElapsed),
            rr: recheckedInputs.rr,
            hr: recheckedInputs.hr,
            hob: inputs.currentHob,
            spo2: recheckedInputs.spo2,
            eventType: 'confirmed',
            eventLabel: '재측정',
          },
        ],
      });

      onAddEmrRecord({
        id: `recheck-${Date.now()}`,
        timestamp: makeTimestamp(),
        createdAtMs: Date.now(),
        isPractice: isPractice || undefined,
        bedNumber: activePatient.bedNumber,
        patientName: activePatient.patientName,
        prevHob: inputs.currentHob,
        appliedHob: inputs.currentHob,
        kneeGatch: displayKnee,
        revTilt: displayRevTilt,
        lateralTilt: inputs.lateralTilt,
        preVitals: {
          rr: inputs.rr,
          hr: inputs.hr,
          spo2: inputs.spo2,
          bp: `${inputs.sbp}/${inputs.dbp}`,
        },
        postVitals: {
          rr: recheckedInputs.rr,
          hr: recheckedInputs.hr,
          spo2: recheckedInputs.spo2,
          bp: `${inputs.sbp}/${inputs.dbp}`,
        },
        stabilizationMinutes: 0,
        verdict: `[재측정 기록] 상태: ${nextSt.label} · 호흡 ${recheckedInputs.rr}회, 맥박 ${recheckedInputs.hr}회, 산소 ${recheckedInputs.spo2}%`,
      });
      showToast(`${activePatient.bedNumber} · 재측정 기록 저장 (${nextSt.label})`);
      return;
    }

    const compareText = `호흡 ${snap.rr}→${recheckInputs.rr}회 · 맥박 ${snap.hr}→${recheckInputs.hr}회 · 산소 ${snap.spo2}→${recheckInputs.spo2}%`;
    const vitalsStr = `호흡 ${recheckInputs.rr}회 · 맥박 ${recheckInputs.hr}회 · 산소 ${recheckInputs.spo2}%`;

    const newlyDetectedCats = getCriticalRiskCategories(recheckedInputs).filter(
      (cat) => !curCrit.episodeRiskCategories.includes(cat)
    );
    const mergedCategories = Array.from(
      new Set([...curCrit.episodeRiskCategories, ...newlyDetectedCats])
    );
    const isSafeNow = areVitalsRelaxedSafe(recheckedInputs) && newlyDetectedCats.length === 0;

    let nextCritState: CriticalAlertState;
    let statusLabel: string;
    let timelineLogMsg: string;

    if (isSafeNow) {
      const nextSafeCount = (curCrit.consecutiveSafeRechecks ?? 0) + 1;
      if (nextSafeCount >= 2) {
        nextCritState = {
          ...curCrit,
          stage: 'resolved',
          episodeRiskCategories: mergedCategories,
          notifiedSnapshot: {
            rr: recheckInputs.rr,
            hr: recheckInputs.hr,
            spo2: recheckInputs.spo2,
            sbp: inputs.sbp,
            dbp: inputs.dbp,
          },
          noImprovementCount: 0,
          consecutiveSafeRechecks: 2,
          lastRecheckAtClock: clockKor,
          lastOutcome: 'improved',
          lastOutcomeDetail: `호전 종료 (2회 연속 안정 · ${compareText})`,
          timeline: [
            ...curCrit.timeline,
            {
              id: `step-recheck-${Date.now()}`,
              stepType: 'recheck',
              clockLabel: clockKor,
              title: '재측정 · 여유 기준 충족 (2/2회)',
              detail: compareText,
              vitalsSummary: vitalsStr,
            },
            {
              id: `step-outcome-${Date.now() + 1}`,
              stepType: 'outcome',
              clockLabel: clockKor,
              title: '호전 시 종료',
              detail: '여유 기준(맥박 ≤120, 호흡 10~26, 산소 ≥93/88%) 2회 연속 확인',
              vitalsSummary: vitalsStr,
            },
          ],
        };
        statusLabel = '호전 종료';
        timelineLogMsg = `재측정(${clockKor}) → 2회 연속 안정, 위험 대응 종료`;
      } else {
        nextCritState = {
          ...curCrit,
          stage: 'observing',
          episodeRiskCategories: mergedCategories,
          notifiedSnapshot: {
            rr: recheckInputs.rr,
            hr: recheckInputs.hr,
            spo2: recheckInputs.spo2,
            sbp: inputs.sbp,
            dbp: inputs.dbp,
          },
          noImprovementCount: 0,
          consecutiveSafeRechecks: 1,
          lastRecheckAtClock: clockKor,
          lastOutcome: 'improved',
          lastOutcomeDetail: `안정 추세 1/2회 (${compareText})`,
          timeline: [
            ...curCrit.timeline,
            {
              id: `step-recheck-${Date.now()}`,
              stepType: 'recheck',
              clockLabel: clockKor,
              title: '재측정 · 안정 추세 (1/2회)',
              detail: `1회 더 연속 안정 확인 시 종료 (${compareText})`,
              vitalsSummary: vitalsStr,
            },
          ],
        };
        statusLabel = '처치 중 관찰 (안정 1/2)';
        timelineLogMsg = `재측정(${clockKor}) → 안정 추세 1/2회 확인`;
      }
    } else {
      const nextNoImprove = (curCrit.noImprovementCount ?? 0) + 1;
      const shouldShowEscalation = nextNoImprove >= 2 && !curCrit.seniorEscalationShown;
      const enterContinuous = nextNoImprove >= 2;

      const recheckStep: CriticalEpisodeTimelineEntry = {
        id: `step-recheck-${Date.now()}`,
        stepType: 'recheck',
        clockLabel: clockKor,
        title: `재측정 · 호전 없음 ${nextNoImprove}회`,
        detail: shouldShowEscalation
          ? `연속 2회 호전 없음 — 상급 의료진·신속대응 요청 고려 (${compareText})`
          : newlyDetectedCats.length > 0
            ? `새 위험 항목(${newlyDetectedCats.map(formatCriticalCategoryKo).join(', ')}) 추가 (${compareText})`
            : `${compareText} (관찰 유지)`,
        vitalsSummary: vitalsStr,
      };
      const extraOutcomeStep: CriticalEpisodeTimelineEntry[] = shouldShowEscalation
        ? [
            {
              id: `step-outcome-${Date.now() + 1}`,
              stepType: 'outcome',
              clockLabel: clockKor,
              title: '상급 의료진·신속대응 요청 고려 (1회 안내)',
              detail: '호전 없음 2회(가정값) 도달 · 지속 관찰 전환',
              vitalsSummary: vitalsStr,
            },
          ]
        : [];

      nextCritState = {
        ...curCrit,
        stage:
          newlyDetectedCats.length > 0
            ? 'alert_required'
            : enterContinuous
              ? 'continuous_observation'
              : 'observing',
        episodeRiskCategories: mergedCategories,
        notifiedSnapshot: {
          rr: recheckInputs.rr,
          hr: recheckInputs.hr,
          spo2: recheckInputs.spo2,
          sbp: inputs.sbp,
          dbp: inputs.dbp,
        },
        noImprovementCount: nextNoImprove,
        consecutiveSafeRechecks: 0,
        seniorEscalationShown: curCrit.seniorEscalationShown || shouldShowEscalation,
        seniorEscalationAcknowledged: curCrit.seniorEscalationShown
          ? curCrit.seniorEscalationAcknowledged
          : false,
        newCategoryAlertNote:
          newlyDetectedCats.length > 0
            ? `새 위험 항목 추가: ${newlyDetectedCats.map(formatCriticalCategoryKo).join(', ')}`
            : undefined,
        lastRecheckAtClock: clockKor,
        lastOutcome: 'unchanged',
        lastOutcomeDetail: `호전 없음 ${nextNoImprove}회 (${compareText})`,
        timeline: [...curCrit.timeline, recheckStep, ...extraOutcomeStep],
      };

      statusLabel =
        newlyDetectedCats.length > 0
          ? '새 위험 항목 알림 필요'
          : enterContinuous
            ? '지시 대기·지속 관찰'
            : '처치 중 관찰';
      timelineLogMsg = shouldShowEscalation
        ? `호전 없음 2회 · 상급 의료진·신속대응 요청 고려`
        : `호전 없음 ${nextNoImprove}회 (${compareText})`;
    }

    setLastSimRecoveryBadge(null);
    onUpdatePatient({
      ...activePatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed,
      minutesSinceReposition: nextMaintained,
      lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, inputs.lateralTilt),
      criticalAlert: nextCritState,
      inputs: recheckedInputs,
      history: [
        ...activePatient.history.slice(-7),
        {
          timeLabel: formatClockFromElapsed(nextElapsed),
          rr: recheckInputs.rr,
          hr: recheckInputs.hr,
          hob: inputs.currentHob,
          spo2: recheckInputs.spo2,
          eventType: 'confirmed',
          eventLabel: isSafeNow ? '재측정 안정' : '재측정',
        },
      ],
    });

    setTimeEvents((prev) =>
      [
        {
          id: `t-recheck-${Date.now()}`,
          proposalKey: `${epId}-recheck-latest`,
          elapsedLabel,
          type: 'confirmed' as const,
          message: timelineLogMsg,
        },
        ...prev.filter((e) => e.proposalKey !== `${epId}-recheck-latest`),
      ].slice(0, 8)
    );

    upsertCriticalEpisodeEmrFor(activePatient, nextCritState, {
      preInputs: preFull,
      latestInputs: recheckedInputs,
      prevHob: inputs.currentHob,
      appliedHob: inputs.currentHob,
      statusLabel,
      verdict: timelineLogMsg,
      isPractice,
    });

    showToast(`${activePatient.bedNumber} · ${timelineLogMsg}`);
  };

  // 원클릭 각도 적용 (추천 각도 / 선택 각도 -> 적용 + 타이머 갱신 + 기록 저장 + 3초 토스트)
  const handleApplyAngleForPatient = (
    targetPatient: WardPatient,
    targetHobInput: number,
    revTiltOverride?: number,
    ackKey?: string,
    opts?: { isPractice?: boolean; criticalConfirmedOverride?: boolean }
  ) => {
    const curInputs = targetPatient.inputs;
    const isCrit = evaluatePatientVitalStatus(curInputs).level === 'critical';
    const curCrit = normalizeCriticalAlertState(targetPatient.criticalAlert);
    const critNotified =
      curCrit.stage === 'awaiting_order' ||
      curCrit.stage === 'observing' ||
      curCrit.stage === 'continuous_observation' ||
      curCrit.stage === 'resolved' ||
      (targetPatient.id === activePatient.id && doctorNotified);
    const critConfirmed = opts?.criticalConfirmedOverride ?? criticalApplyConfirmed;

    if (isCrit && (!critNotified || !critConfirmed)) {
      return;
    }

    const revTilt = revTiltOverride ?? 0;
    const finalHob = revTilt > 0 ? 0 : targetHobInput;
    const nextSim = virtualMode
      ? simulateVitalsAtAngle(curInputs, finalHob)
      : {
          rr: curInputs.rr,
          hr: curInputs.hr,
          spo2: curInputs.spo2,
          sbp: curInputs.sbp,
          dbp: curInputs.dbp,
        };

    const nextElapsed = getNextUniqueElapsedFor(targetPatient, 1);
    const ptStart = Math.max(0, Math.min(targetPatient.repositionStartedAtElapsed ?? 0, nextElapsed));
    const nextMaintained = Math.max(0, nextElapsed - ptStart);
    const recAudit = checkAngleAppropriateness(finalHob, { ...curInputs, ...nextSim });
    const nextHobDisplay = revTilt > 0 ? `침대 전체 +${revTilt}°` : `${finalHob}°`;

    onUpdatePatient({
      ...targetPatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed: ptStart,
      minutesSinceReposition: nextMaintained,
      lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, curInputs.lateralTilt),
      minutesAbove45: finalHob > HIGH_ANGLE_HOB_THRESHOLD ? targetPatient.minutesAbove45 : 0,
      highAngleProposedForCycle:
        finalHob > HIGH_ANGLE_HOB_THRESHOLD ? targetPatient.highAngleProposedForCycle : false,
      inputs: {
        ...curInputs,
        ...nextSim,
        currentHob: finalHob,
      },
      history: [
        ...targetPatient.history.slice(-7),
        {
          timeLabel: formatClockFromElapsed(nextElapsed),
          rr: nextSim.rr,
          hr: nextSim.hr,
          hob: revTilt > 0 ? revTilt : finalHob,
          spo2: nextSim.spo2,
          eventType: 'confirmed',
          eventLabel: `${revTilt > 0 ? `+${revTilt}°` : `${finalHob}°`} 적용`,
        },
      ],
    });

    if (ackKey) {
      setAcknowledgedAngleKeys((prev) => ({ ...prev, [targetPatient.id]: ackKey }));
    }
    setCriticalApplyConfirmed(false);
    setRecheckInputs({ rr: nextSim.rr, hr: nextSim.hr, spo2: nextSim.spo2 });
    setRecheckPanelOpen(true);

    onAddEmrRecord({
      id: `angle-apply-${Date.now()}`,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      isPractice: opts?.isPractice || undefined,
      bedNumber: targetPatient.bedNumber,
      patientName: targetPatient.patientName,
      prevHob: curInputs.currentHob,
      appliedHob: finalHob,
      kneeGatch: recAudit.targetKneeGatch,
      revTilt,
      lateralTilt: curInputs.lateralTilt,
      preVitals: {
        rr: curInputs.rr,
        hr: curInputs.hr,
        spo2: curInputs.spo2,
        bp: `${curInputs.sbp}/${curInputs.dbp}`,
      },
      postVitals: {
        rr: nextSim.rr,
        hr: nextSim.hr,
        spo2: nextSim.spo2,
        bp: `${nextSim.sbp}/${nextSim.dbp}`,
      },
      stabilizationMinutes: 0,
      verdict: `[간호사 확인 · 각도 적용] ${curInputs.currentHob}° → ${nextHobDisplay} (무릎 받침 ${recAudit.targetKneeGatch}°)${
        isCrit ? ' · 의료진 확인 후 적용' : ''
      }`,
    });

    showToast(
      `${targetPatient.bedNumber} ${targetPatient.patientName} · ${nextHobDisplay} 적용 및 간호 기록 저장 완료`
    );
  };

  // (11)② 제안한 자세와 실제 적용·기록되는 자세를 정확히 일치시키는 체위변경 적용
  const applyLateralTiltForPatient = (
    targetPatient: WardPatient,
    tilt: LateralTiltPosition,
    extraNote?: string
  ) => {
    const ptInputs = targetPatient.inputs;
    const prevTilt = ptInputs.lateralTilt;
    const ptElapsed = Math.max(0, targetPatient.elapsedMinutes ?? 0);
    const ptStart = Math.max(0, Math.min(targetPatient.repositionStartedAtElapsed ?? 0, ptElapsed));
    const maintainedMin = Math.max(0, ptElapsed - ptStart);

    const nextLastSideTilt: 'left_30' | 'right_30' =
      tilt === 'left_30' || tilt === 'right_30'
        ? tilt
        : prevTilt === 'left_30' || prevTilt === 'right_30'
          ? prevTilt
          : targetPatient.lastSideTilt ?? 'right_30';

    const knee =
      ptInputs.currentHob > 30
        ? ptInputs.pressureInjuryHighRisk || ptInputs.sacralSkinStatus !== 'intact'
          ? 15
          : 12
        : 0;
    const rev =
      ptInputs.spinalOrHipContraindication && ptInputs.currentHob === 0
        ? evaluateBedAngleProtocol(ptInputs).reverseTrendelenburgDeg
        : 0;

    setHoldTargetPatientId(null);
    setStickyCriticalTiltChecked(false);

    onUpdatePatient({
      ...targetPatient,
      elapsedMinutes: ptElapsed,
      repositionStartedAtElapsed: ptElapsed,
      minutesSinceReposition: 0,
      lastSideTilt: nextLastSideTilt,
      repositionProposedForCycle: false,
      repositionHoldCount: 0,
      repositionSnoozeMinutesLeft: 0,
      lastRepositionedLabel: formatRepositionAgoLabel(0, tilt),
      inputs: {
        ...ptInputs,
        lateralTilt: tilt,
      },
    });

    onAddEmrRecord({
      id: `reposition-${Date.now()}`,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      bedNumber: targetPatient.bedNumber,
      patientName: targetPatient.patientName,
      prevHob: ptInputs.currentHob,
      appliedHob: ptInputs.currentHob,
      kneeGatch: knee,
      revTilt: rev,
      lateralTilt: tilt,
      preVitals: {
        rr: ptInputs.rr,
        hr: ptInputs.hr,
        spo2: ptInputs.spo2,
        bp: `${ptInputs.sbp}/${ptInputs.dbp}`,
      },
      stabilizationMinutes: 0,
      repositionMeta: {
        prevTilt,
        newTilt: tilt,
        maintainedMinutes: maintainedMin,
        isHold: false,
      },
      verdict: `[체위변경 기록${extraNote ? ` · ${extraNote}` : ''}] ${formatTiltKo(
        prevTilt
      )} (${maintainedMin}분 유지) → ${formatTiltKo(tilt)} (타이머 0분 초기화)`,
    });

    showToast(
      `${targetPatient.bedNumber} ${targetPatient.patientName} · ${formatTiltKo(tilt)} 적용 및 타이머 초기화 완료`
    );
  };

  // (11)③ 사유 칩 클릭 즉시 보류 저장 (15분 뒤 재알림 · 보류 횟수와 사유 기록)
  const handleHoldRepositionForPatient = (
    targetPatient: WardPatient,
    chipReason: HoldChipReason
  ) => {
    const customTrimmed = customHoldReason.trim();
    const reasonText =
      chipReason === '기타' && customTrimmed ? `기타 (${customTrimmed})` : chipReason;
    const nextHoldCount = (targetPatient.repositionHoldCount ?? 0) + 1;
    const ptInputs = targetPatient.inputs;
    const prevTilt = ptInputs.lateralTilt;
    const ptElapsed = Math.max(0, targetPatient.elapsedMinutes ?? 0);
    const ptStart = Math.max(0, Math.min(targetPatient.repositionStartedAtElapsed ?? 0, ptElapsed));
    const maintainedMin = Math.max(0, ptElapsed - ptStart);

    const knee =
      ptInputs.currentHob > 30
        ? ptInputs.pressureInjuryHighRisk || ptInputs.sacralSkinStatus !== 'intact'
          ? 15
          : 12
        : 0;

    onUpdatePatient({
      ...targetPatient,
      repositionProposedForCycle: true,
      repositionHoldCount: nextHoldCount,
      repositionSnoozeMinutesLeft: 15,
    });

    onAddEmrRecord({
      id: `reposition-hold-${Date.now()}`,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      bedNumber: targetPatient.bedNumber,
      patientName: targetPatient.patientName,
      prevHob: ptInputs.currentHob,
      appliedHob: ptInputs.currentHob,
      kneeGatch: knee,
      revTilt: 0,
      lateralTilt: prevTilt,
      preVitals: {
        rr: ptInputs.rr,
        hr: ptInputs.hr,
        spo2: ptInputs.spo2,
        bp: `${ptInputs.sbp}/${ptInputs.dbp}`,
      },
      stabilizationMinutes: 0,
      repositionMeta: {
        prevTilt,
        newTilt: prevTilt,
        maintainedMinutes: maintainedMin,
        isHold: true,
        holdCount: nextHoldCount,
        holdReason: reasonText,
      },
      verdict: `[체위변경 보류 ${nextHoldCount}회 · 15분 뒤 재알림] ${formatTiltKo(
        prevTilt
      )} (${maintainedMin}분 유지) · 사유: ${reasonText}${
        nextHoldCount >= 3 ? ' · 반복 보류 — 간호사 확인 필요' : ''
      }`,
    });

    setHoldTargetPatientId(null);
    setCustomHoldReason('');
    showToast(
      `${targetPatient.bedNumber} · 보류 저장됨 (${reasonText}, ${nextHoldCount}회 · 15분 뒤 재알림)`
    );
  };

  // 시간 경과 시뮬레이션 (가상 모드 켜짐: 처치/각도 후 수치 서서히 정상화 · 꺼짐: 시간만 흐르고 수치 고정)
  const advanceTimeBy = (deltaMin: number, isPractice?: boolean) => {
    const markPractice = isPractice ?? virtualMode;
    const prevElapsed = Math.max(0, activePatient.elapsedMinutes ?? 0);
    const nextElapsed = getNextUniqueElapsedFor(activePatient, deltaMin);
    const elapsedLabel = `+${formatElapsed(nextElapsed)} (${formatClockFromElapsed(nextElapsed)})`;
    const curInputs = activePatient.inputs;
    const curCrit = normalizeCriticalAlertState(activePatient.criticalAlert);
    const isEpisodeActive = curCrit.stage !== 'idle' && curCrit.stage !== 'resolved';
    const prevAudit = checkAngleAppropriateness(curInputs.currentHob, curInputs);
    const prevCritStatus = evaluatePatientVitalStatus(curInputs);
    const wasCriticalBlocking =
      curCrit.stage !== 'resolved' &&
      (curCrit.stage === 'alert_required' ||
        curCrit.stage === 'awaiting_order' ||
        curCrit.stage === 'observing' ||
        curCrit.stage === 'continuous_observation' ||
        prevCritStatus.level === 'critical');
    const prevHighAngleDue =
      !wasCriticalBlocking &&
      curInputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD &&
      (activePatient.minutesAbove45 ?? 0) >= HIGH_ANGLE_LIMIT_MINUTES &&
      !activePatient.highAngleProposedForCycle;
    const prevTargetAngle =
      prevHighAngleDue && !prevAudit.isWrongAngle && curInputs.rr <= 21
        ? 35
        : prevAudit.targetHob;
    const prevHasAngleDiff =
      (prevAudit.targetRevTilt > 0 && curInputs.currentHob !== 0) ||
      (prevAudit.targetRevTilt === 0 && prevTargetAngle !== curInputs.currentHob);
    const prevAngleKey = `${curInputs.currentHob}|${prevCritStatus.level}|${
      prevAudit.targetRevTilt > 0 ? `+${prevAudit.targetRevTilt}` : prevTargetAngle
    }`;
    const prevRespAlertKey =
      !wasCriticalBlocking &&
      (prevAudit.isWrongAngle || prevHighAngleDue) &&
      prevHasAngleDiff &&
      acknowledgedAngleKeys[activePatient.id] !== prevAngleKey
        ? prevAngleKey
        : null;

    let nextRr = curInputs.rr;
    let nextHr = curInputs.hr;
    let nextSpo2 = curInputs.spo2;
    let nextSbp = curInputs.sbp;
    let nextDbp = curInputs.dbp;
    let nextBorg = curInputs.borgScore;
    let simulatedRecoveryApplied = false;

    const nextMinutesSinceReposition = Math.max(0, nextElapsed - repositionStartedAtElapsed);
    const nextMinutesAbove45 =
      curInputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD
        ? (activePatient.minutesAbove45 ?? 0) + deltaMin
        : 0;
    const prevSnooze = activePatient.repositionSnoozeMinutesLeft ?? 0;
    const nextSnooze = prevSnooze > 0 ? Math.max(0, prevSnooze - deltaMin) : 0;

    if (virtualMode) {
      // ×1(1분), ×10(10분)에서도 비현실적으로 급변하지 않도록 15분 경계 또는 5분 단위 완만 적용
      const crossed15 = Math.floor(nextElapsed / 15) - Math.floor(prevElapsed / 15);
      const crossed5 = Math.floor(nextElapsed / 5) - Math.floor(prevElapsed / 5);
      const steps =
        deltaMin >= 15
          ? Math.max(1, Math.round(deltaMin / 15))
          : deltaMin >= 10
            ? crossed15
            : 0;
      const miniStep = deltaMin < 10 ? crossed5 : 0;

      if (steps > 0 || miniStep > 0) {
        const rrStep = steps > 0 ? 2 * steps : miniStep;
        const hrStep = steps > 0 ? 7 * steps : 2 * miniStep;
        const spo2Step = steps > 0 ? 2 * steps : miniStep;
        const sbpStep = steps > 0 ? 5 * steps : 2 * miniStep;
        const dbpStep = steps > 0 ? 3 * steps : miniStep;
        const borgStep = steps > 0 ? steps : crossed15;

        if (isEpisodeActive) {
          if (curCrit.stage === 'observing' || curCrit.stage === 'continuous_observation') {
            if (curInputs.rr > 18) nextRr = Math.max(18, curInputs.rr - rrStep);
            else if (curInputs.rr < 14) nextRr = Math.min(16, curInputs.rr + rrStep);

            if (curInputs.hr > 84) nextHr = Math.max(84, curInputs.hr - hrStep);
            else if (curInputs.hr < 64) nextHr = Math.min(68, curInputs.hr + (steps > 0 ? 5 * steps : 2 * miniStep));

            const targetSpo2 = curInputs.copdTargetMode ? 91 : 97;
            if (curInputs.spo2 < targetSpo2) {
              nextSpo2 = Math.min(targetSpo2, curInputs.spo2 + spo2Step);
            }

            if (curInputs.sbp < 110) {
              nextSbp = Math.min(118, curInputs.sbp + sbpStep);
              nextDbp = Math.min(74, curInputs.dbp + dbpStep);
            }

            if (borgStep > 0) {
              nextBorg = Math.max(2, curInputs.borgScore - borgStep);
            }
            simulatedRecoveryApplied =
              nextRr !== curInputs.rr ||
              nextHr !== curInputs.hr ||
              nextSpo2 !== curInputs.spo2 ||
              nextSbp !== curInputs.sbp;
          }
        } else {
          if (curInputs.currentHob >= 60) {
            nextRr = Math.max(17, curInputs.rr - rrStep);
            nextHr = Math.max(78, curInputs.hr - (steps > 0 ? 4 * steps : 2 * miniStep));
            const targetSpo2 = curInputs.copdTargetMode ? 91 : 98;
            nextSpo2 = Math.min(targetSpo2, curInputs.spo2 + (steps > 0 ? steps : miniStep));
            if (borgStep > 0) nextBorg = Math.max(2, curInputs.borgScore - borgStep);
            if (curInputs.orthostaticHistory) {
              nextSbp = Math.max(
                84,
                curInputs.sbp - (deltaMin >= 5 ? Math.ceil(deltaMin / 5) : miniStep)
              );
            }
          } else if (curInputs.currentHob <= 15 && !curInputs.spinalOrHipContraindication) {
            if (steps > 0) {
              nextRr = Math.min(31, curInputs.rr + Math.ceil(deltaMin / 10));
              nextHr = Math.min(132, curInputs.hr + Math.ceil(deltaMin / 12));
              nextSpo2 = Math.max(88, curInputs.spo2 - Math.max(1, Math.floor(deltaMin / 15)));
              nextBorg = Math.min(8, curInputs.borgScore + Math.max(1, Math.floor(deltaMin / 15)));
            } else if (miniStep > 0) {
              nextRr = Math.min(31, curInputs.rr + miniStep);
              nextHr = Math.min(132, curInputs.hr + miniStep);
              if (crossed15 > 0) {
                nextSpo2 = Math.max(88, curInputs.spo2 - crossed15);
                nextBorg = Math.min(8, curInputs.borgScore + crossed15);
              }
            }
          } else if (curInputs.currentHob >= 30 && curInputs.currentHob < 60) {
            if (curInputs.rr > 18) nextRr = Math.max(18, curInputs.rr - (steps > 0 ? steps : miniStep));
            if (curInputs.hr > 82) {
              nextHr = Math.max(80, curInputs.hr - (steps > 0 ? 3 * steps : miniStep));
            }
            const targetSpo2 = curInputs.copdTargetMode ? 91 : 97;
            if (curInputs.spo2 < targetSpo2) {
              nextSpo2 = Math.min(targetSpo2, curInputs.spo2 + (steps > 0 ? steps : miniStep));
            }
            if (curInputs.sbp < 110) {
              nextSbp = Math.min(118, curInputs.sbp + (steps > 0 ? 4 * steps : miniStep));
              nextDbp = Math.min(74, curInputs.dbp + (steps > 0 ? 2 * steps : miniStep));
            }
            if (borgStep > 0) nextBorg = Math.max(2, curInputs.borgScore - borgStep);
          }
          simulatedRecoveryApplied =
            nextRr !== curInputs.rr ||
            nextHr !== curInputs.hr ||
            nextSpo2 !== curInputs.spo2 ||
            nextSbp !== curInputs.sbp;
        }
      }
    }

    const simulatedInputs: PatientInputs = {
      ...curInputs,
      rr: nextRr,
      hr: nextHr,
      spo2: nextSpo2,
      sbp: nextSbp,
      dbp: nextDbp,
      borgScore: nextBorg,
    };

    const audit = checkAngleAppropriateness(curInputs.currentHob, simulatedInputs);
    const nextCats = getCriticalRiskCategories(simulatedInputs);
    let nextCritState: CriticalAlertState = curCrit;
    let newCriticalTriggered = false;

    if (simulatedRecoveryApplied) {
      setRecheckInputs({ rr: nextRr, hr: nextHr, spo2: nextSpo2 });
      setLastSimRecoveryBadge(
        `가상 변화: 호흡 ${curInputs.rr}→${nextRr} · 맥박 ${curInputs.hr}→${nextHr} · 산소 ${curInputs.spo2}→${nextSpo2}%`
      );
    }

    if (isEpisodeActive) {
      const brandNewCats = nextCats.filter((c) => !curCrit.episodeRiskCategories.includes(c));
      if (brandNewCats.length > 0) {
        newCriticalTriggered = true;
        setDoctorNotified(false);
        nextCritState = {
          ...curCrit,
          stage: 'alert_required',
          episodeRiskCategories: Array.from(
            new Set([...curCrit.episodeRiskCategories, ...brandNewCats])
          ),
          newCategoryAlertNote: `새 위험 항목 추가: ${brandNewCats
            .map(formatCriticalCategoryKo)
            .join(', ')}`,
        };
      }
    } else if (audit.decision.vitalStatus.level === 'critical') {
      newCriticalTriggered = true;
      setDoctorNotified(false);
      nextCritState = {
        ...DEFAULT_CRITICAL_ALERT_STATE,
        stage: 'alert_required',
        episodeId: `crit-${activePatient.id}-${nextElapsed}`,
        episodeStartedClock: formatClockKorFromElapsed(nextElapsed),
        episodeRiskCategories: nextCats,
      };
    } else if (curCrit.stage === 'resolved') {
      nextCritState = DEFAULT_CRITICAL_ALERT_STATE;
    }

    const isCriticalBlocking =
      nextCritState.stage !== 'resolved' &&
      (nextCritState.stage === 'alert_required' ||
        nextCritState.stage === 'awaiting_order' ||
        nextCritState.stage === 'observing' ||
        nextCritState.stage === 'continuous_observation' ||
        audit.decision.vitalStatus.level === 'critical');

    const curInterval =
      activePatient.customRepositionIntervalMin ?? getDefaultRepositionInterval(curInputs);
    const nextDelayMinutes = Math.max(0, nextMinutesSinceReposition - curInterval);

    if (nextDelayMinutes > 0) {
      upsertRepositionDelayEmrFor(
        activePatient,
        repositionStartedAtElapsed,
        nextMinutesSinceReposition,
        curInterval,
        simulatedInputs,
        isCriticalBlocking,
        markPractice
      );
    }

    const wasProposedReposition = Boolean(activePatient.repositionProposedForCycle);
    const severeThreshold = Math.round(curInterval * 1.5);
    const triggeredThisTick =
      nextMinutesSinceReposition >= curInterval &&
      nextSnooze === 0 &&
      (!isCriticalBlocking || nextMinutesSinceReposition >= severeThreshold);

    const highAngleDue =
      !isCriticalBlocking &&
      curInputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD &&
      nextMinutesAbove45 >= HIGH_ANGLE_LIMIT_MINUTES &&
      !activePatient.highAngleProposedForCycle;

    const nextTargetAngle =
      highAngleDue && !audit.isWrongAngle && simulatedInputs.rr <= 21 ? 35 : audit.targetHob;
    const nextHasAngleDiff =
      (audit.targetRevTilt > 0 && simulatedInputs.currentHob !== 0) ||
      (audit.targetRevTilt === 0 && nextTargetAngle !== simulatedInputs.currentHob);
    const nextAngleKey = `${simulatedInputs.currentHob}|${audit.decision.vitalStatus.level}|${
      audit.targetRevTilt > 0 ? `+${audit.targetRevTilt}` : nextTargetAngle
    }`;
    const nextRespAlertKey =
      !isCriticalBlocking &&
      (audit.isWrongAngle || highAngleDue) &&
      nextHasAngleDiff &&
      acknowledgedAngleKeys[activePatient.id] !== nextAngleKey
        ? nextAngleKey
        : null;
    const newRespAlertTriggered =
      nextRespAlertKey !== null && nextRespAlertKey !== prevRespAlertKey;

    // 자동 재생 중 새 알림(위험 또는 호흡·각도/고각도 경고)이 뜨면 멈추고 안내 표시 (단, 체위변경 제안은 계속 흐름)
    if (newCriticalTriggered || newRespAlertTriggered) {
      if (timeFlowPlaying) {
        setStoppedByAlertNotice(true);
      }
      setTimeFlowPlaying(false);
    }

    if (triggeredThisTick && !wasProposedReposition) {
      setTimeEvents((prev) =>
        [
          {
            id: `t-rep-${Date.now()}`,
            elapsedLabel,
            type: 'pressure' as const,
            message: `${activePatient.bedNumber} 체위변경(몸 돌리기) 기준 ${curInterval}분 도달 → ${formatTiltKo(
              getNextCycleTilt(curInputs.lateralTilt, activePatient.lastSideTilt ?? 'right_30')
            )}`,
          },
          ...prev,
        ].slice(0, 8)
      );
    }

    onUpdatePatient({
      ...activePatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed,
      minutesSinceReposition: nextMinutesSinceReposition,
      lastRepositionedLabel: formatRepositionAgoLabel(
        nextMinutesSinceReposition,
        curInputs.lateralTilt
      ),
      repositionProposedForCycle: wasProposedReposition || triggeredThisTick,
      repositionSnoozeMinutesLeft: nextSnooze,
      minutesAbove45: nextMinutesAbove45,
      highAngleProposedForCycle:
        curInputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD
          ? activePatient.highAngleProposedForCycle || highAngleDue
          : false,
      criticalAlert: nextCritState,
      inputs: simulatedInputs,
      history: [
        ...activePatient.history.slice(-7),
        {
          timeLabel: formatClockFromElapsed(nextElapsed),
          rr: nextRr,
          hr: nextHr,
          hob: curInputs.currentHob,
          spo2: nextSpo2,
          isSimulatedRecovery: simulatedRecoveryApplied,
          eventType: 'time',
          eventLabel: simulatedRecoveryApplied ? '시연 변화' : undefined,
        },
      ],
    });

    if (isPractice) {
      showToast(
        `${activePatient.bedNumber} · 시간 +${deltaMin}분 경과 (누적 ${nextElapsed}분)`
      );
    }
  };

  // 체험 도구: 상황 만들기 프리셋 적용
  const handleApplyPresetFromPractice = (preset: PracticeScenarioPreset) => {
    const nextInputs: PatientInputs = { ...inputs, ...preset.patch };
    const nextVs = evaluatePatientVitalStatus(nextInputs);
    const nextElapsed = getNextUniqueElapsedFor(activePatient, 1);
    const nextMaintained = Math.max(0, nextElapsed - repositionStartedAtElapsed);
    const nextCritCats = getCriticalRiskCategories(nextInputs);

    let nextCritState: CriticalAlertState = DEFAULT_CRITICAL_ALERT_STATE;
    if (!preset.resetCritical && nextVs.level === 'critical') {
      nextCritState = {
        ...DEFAULT_CRITICAL_ALERT_STATE,
        stage: 'alert_required',
        episodeId: `crit-${activePatient.id}-${nextElapsed}`,
        episodeStartedClock: formatClockKorFromElapsed(nextElapsed),
        episodeRiskCategories: nextCritCats,
      };
    }

    setTimeFlowPlaying(false);
    setDoctorNotified(false);
    setCriticalApplyConfirmed(false);
    setRecheckInputs({ rr: nextInputs.rr, hr: nextInputs.hr, spo2: nextInputs.spo2 });
    setLastSimRecoveryBadge(null);

    onUpdatePatient({
      ...activePatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed,
      minutesSinceReposition: nextMaintained,
      lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, nextInputs.lateralTilt),
      criticalAlert: nextCritState,
      inputs: nextInputs,
      history: [
        ...activePatient.history.slice(-7),
        {
          timeLabel: formatClockFromElapsed(nextElapsed),
          rr: nextInputs.rr,
          hr: nextInputs.hr,
          hob: nextInputs.currentHob,
          spo2: nextInputs.spo2,
          eventType: 'input',
          eventLabel: `체험:${preset.label}`,
        },
      ],
    });

    onAddEmrRecord({
      id: `practice-preset-${Date.now()}`,
      timestamp: makeTimestamp(),
      createdAtMs: Date.now(),
      isPractice: true,
      bedNumber: activePatient.bedNumber,
      patientName: activePatient.patientName,
      prevHob: inputs.currentHob,
      appliedHob: nextInputs.currentHob,
      kneeGatch: nextInputs.currentHob > 30 ? 12 : 0,
      revTilt: 0,
      lateralTilt: nextInputs.lateralTilt,
      preVitals: {
        rr: inputs.rr,
        hr: inputs.hr,
        spo2: inputs.spo2,
        bp: `${inputs.sbp}/${inputs.dbp}`,
      },
      postVitals: {
        rr: nextInputs.rr,
        hr: nextInputs.hr,
        spo2: nextInputs.spo2,
        bp: `${nextInputs.sbp}/${nextInputs.dbp}`,
      },
      stabilizationMinutes: 0,
      verdict: `[체험 · 상황 만들기: ${preset.label}] 판정 ${nextVs.label} (${preset.shortDesc})`,
    });

    showToast(
      `${activePatient.bedNumber} · '${preset.label}' 상황 적용됨 (${nextVs.label})`
    );
  };

  // 체험 도구: 처음 상태로 초기화
  const handleResetFromPractice = () => {
    setTimeFlowPlaying(false);
    setStoppedByAlertNotice(false);
    setDoctorNotified(false);
    setCriticalApplyConfirmed(false);
    setPendingLateralTilt(null);
    setPendingLateralSafetyChecked(false);
    setHoldTargetPatientId(null);
    setRecheckPanelOpen(false);
    setTimeEvents([]);
    setAcknowledgedAngleKeys({});
    setLastSimRecoveryBadge(null);
    onResetAllToInitial();
    showToast('체험 기록과 모든 환자 수치를 처음 상태로 초기화했습니다');
  };

  const handleToggleTimeFlow = () => {
    if (timeFlowPlaying) {
      setTimeFlowPlaying(false);
    } else {
      setStoppedByAlertNotice(false);
      setTimeFlowPlaying(true);
    }
  };

  const advanceTimeRef = useRef(advanceTimeBy);
  advanceTimeRef.current = advanceTimeBy;

  const isCriticalTickBlocked =
    effectiveCriticalAlert.stage === 'alert_required' ||
    effectiveCriticalAlert.stage === 'awaiting_order';

  useEffect(() => {
    if (!timeFlowPlaying || isCriticalTickBlocked) {
      return;
    }
    const interval = window.setInterval(() => {
      advanceTimeRef.current(timeSpeed);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [timeFlowPlaying, timeSpeed, isCriticalTickBlocked]);

  const triggerCriticalDemo = () => {
    const demoVitals = { rr: 27, hr: 138, spo2: 91, sbp: 106, dbp: 68 };
    const testedAngle = inputs.currentHob;
    const measuredInputs: PatientInputs = {
      ...inputs,
      ...demoVitals,
      borgScore: 7,
      currentHob: testedAngle,
    };

    const nextElapsed = getNextUniqueElapsedFor(activePatient, 1);
    const nextMaintained = Math.max(0, nextElapsed - repositionStartedAtElapsed);
    setTimeFlowPlaying(false);
    setDoctorNotified(false);
    setCriticalApplyConfirmed(false);
    setRecheckInputs({ rr: demoVitals.rr, hr: demoVitals.hr, spo2: demoVitals.spo2 });
    setLastSimRecoveryBadge(null);

    onUpdatePatient({
      ...activePatient,
      elapsedMinutes: nextElapsed,
      repositionStartedAtElapsed,
      minutesSinceReposition: nextMaintained,
      lastRepositionedLabel: formatRepositionAgoLabel(nextMaintained, inputs.lateralTilt),
      criticalAlert: {
        ...DEFAULT_CRITICAL_ALERT_STATE,
        stage: 'alert_required',
        episodeId: `crit-${activePatient.id}-${nextElapsed}`,
        episodeStartedClock: formatClockKorFromElapsed(nextElapsed),
        episodeRiskCategories: getCriticalRiskCategories(measuredInputs),
      },
      inputs: measuredInputs,
      history: [
        ...activePatient.history.slice(-7),
        {
          timeLabel: formatClockFromElapsed(nextElapsed),
          rr: demoVitals.rr,
          hr: demoVitals.hr,
          hob: testedAngle,
          spo2: demoVitals.spo2,
          eventType: 'input',
          eventLabel: '위험 시연',
        },
      ],
    });
    showToast(`${activePatient.bedNumber} · 위험 상황 시연(맥박 138) 시작 — 상단 알림을 확인하세요`);
  };

  const updateField = <K extends keyof PatientInputs>(key: K, value: PatientInputs[K]) => {
    const updatedInputs: PatientInputs = { ...activePatient.inputs, [key]: value };
    const curCrit = normalizeCriticalAlertState(activePatient.criticalAlert);
    const nextCritStatus = evaluatePatientVitalStatus(updatedInputs);
    const nextCritCats = getCriticalRiskCategories(updatedInputs);
    const isEpisodeActive = curCrit.stage !== 'idle' && curCrit.stage !== 'resolved';

    let nextCritState = curCrit;
    if (isEpisodeActive) {
      const brandNewCats = nextCritCats.filter((c) => !curCrit.episodeRiskCategories.includes(c));
      if (brandNewCats.length > 0) {
        setDoctorNotified(false);
        nextCritState = {
          ...curCrit,
          stage: 'alert_required',
          episodeRiskCategories: Array.from(
            new Set([...curCrit.episodeRiskCategories, ...brandNewCats])
          ),
          newCategoryAlertNote: `새 위험 항목 추가: ${brandNewCats
            .map(formatCriticalCategoryKo)
            .join(', ')}`,
        };
      } else if (
        curCrit.stage === 'alert_required' &&
        curCrit.timeline.length === 0 &&
        nextCritStatus.level !== 'critical'
      ) {
        nextCritState = DEFAULT_CRITICAL_ALERT_STATE;
      }
    } else if (nextCritStatus.level === 'critical') {
      setDoctorNotified(false);
      nextCritState = {
        ...DEFAULT_CRITICAL_ALERT_STATE,
        stage: 'alert_required',
        episodeId: `crit-${activePatient.id}-${Date.now()}`,
        episodeStartedClock: formatClockKorFromElapsed(elapsedMinutes),
        episodeRiskCategories: nextCritCats,
      };
    }

    onUpdatePatient({
      ...activePatient,
      criticalAlert: nextCritState,
      inputs: updatedInputs,
    });
  };

  const updateCustomRepositionInterval = (mins: number | null) => {
    const clamped = mins === null ? null : Math.max(15, Math.min(240, Math.round(mins)));
    onUpdatePatient({
      ...activePatient,
      customRepositionIntervalMin: clamped,
      repositionProposedForCycle: false,
    });
  };

  const handleLateralReposition = (tilt: LateralTiltPosition) => {
    if (tilt === inputs.lateralTilt) return;
    if (isCriticalPriorityActive) {
      setPendingLateralTilt(tilt);
      setPendingLateralSafetyChecked(false);
      return;
    }
    applyLateralTiltForPatient(activePatient, tilt);
  };

  const handleConfirmCriticalLateral = (apply: boolean) => {
    if (!pendingLateralTilt) return;
    if (apply) {
      if (!criticalDoctorNotified || !pendingLateralSafetyChecked) return;
      applyLateralTiltForPatient(activePatient, pendingLateralTilt, '위험 상태 의료진 확인');
    }
    setPendingLateralTilt(null);
    setPendingLateralSafetyChecked(false);
  };

  // 전체 병실 통합 알림 큐 (우선순위: 위험 > 호흡 > 체위변경)
  const allAlerts = useMemo<QueuedAlert[]>(() => {
    const list: QueuedAlert[] = [];

    for (const pt of patients) {
      const vs = evaluatePatientVitalStatus(pt.inputs);
      const crit = normalizeCriticalAlertState(pt.criticalAlert);
      const isCritActive =
        crit.stage !== 'resolved' &&
        (crit.stage === 'alert_required' ||
          crit.stage === 'awaiting_order' ||
          crit.stage === 'observing' ||
          crit.stage === 'continuous_observation' ||
          vs.level === 'critical');

      const ptElapsed = Math.max(0, pt.elapsedMinutes ?? 0);
      const ptStart = Math.max(0, Math.min(pt.repositionStartedAtElapsed ?? 0, ptElapsed));
      const ptMaintained = Math.max(0, ptElapsed - ptStart);
      const ptInterval = pt.customRepositionIntervalMin ?? getDefaultRepositionInterval(pt.inputs);
      const ptOverdue = Math.max(0, ptMaintained - ptInterval);
      const ptSevere = ptMaintained >= Math.round(ptInterval * 1.5);
      const ptSnooze = pt.repositionSnoozeMinutesLeft ?? 0;
      const ptNextTilt = getNextCycleTilt(pt.inputs.lateralTilt, pt.lastSideTilt ?? 'right_30');
      const ptAudit = checkAngleAppropriateness(pt.inputs.currentHob, pt.inputs);
      const ptHighAngleDue =
        !isCritActive &&
        pt.inputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD &&
        (pt.minutesAbove45 ?? 0) >= HIGH_ANGLE_LIMIT_MINUTES;

      const activeTie = pt.id === activePatient.id ? 0 : 1;

      if (isCritActive) {
        const effStage = crit.stage === 'idle' ? 'alert_required' : crit.stage;
        const stageScore =
          effStage === 'alert_required' ? 10 : effStage === 'awaiting_order' ? 12 : 14;
        list.push({
          id: `crit-${pt.id}`,
          patient: pt,
          category: 'critical',
          tierScore: stageScore + activeTie,
          title:
            effStage === 'alert_required'
              ? `${pt.bedNumber} ${pt.patientName} · 위험 수치 발생`
              : effStage === 'awaiting_order'
                ? `${pt.bedNumber} ${pt.patientName} · 의료진 지시 입력 필요`
                : `${pt.bedNumber} ${pt.patientName} · 처치 중 관찰 · 재측정`,
          summary: vs.reasons[0] || crit.doctorOrderNote || '위험 수치 확인 필요',
          actionLabel:
            effStage === 'alert_required'
              ? '의료진에게 알리기'
              : effStage === 'awaiting_order'
                ? '지시·처치 입력'
                : '재측정 입력',
          criticalStage: effStage,
        });
      }

      if (!isCritActive && (ptAudit.isWrongAngle || ptHighAngleDue)) {
        const targetAngle =
          ptHighAngleDue && !ptAudit.isWrongAngle && pt.inputs.rr <= 21 ? 35 : ptAudit.targetHob;
        const hasAngleDiff =
          (ptAudit.targetRevTilt > 0 && pt.inputs.currentHob !== 0) ||
          (ptAudit.targetRevTilt === 0 && targetAngle !== pt.inputs.currentHob);
        const angleKey = `${pt.inputs.currentHob}|${vs.level}|${
          ptAudit.targetRevTilt > 0 ? `+${ptAudit.targetRevTilt}` : targetAngle
        }`;
        if (hasAngleDiff && acknowledgedAngleKeys[pt.id] !== angleKey) {
          list.push({
            id: `resp-${pt.id}`,
            patient: pt,
            category: 'respiratory',
            tierScore: 30 + activeTie,
            title: `${pt.bedNumber} ${pt.patientName} · 호흡·각도 조정 필요`,
            summary: ptAudit.decision.ruleConflicts[0] || ptAudit.decision.shortReason,
            actionLabel:
              ptAudit.targetRevTilt > 0
                ? `침대 전체 +${ptAudit.targetRevTilt}° 적용`
                : `${targetAngle}° 적용`,
            targetAngle,
            targetRevTilt: ptAudit.targetRevTilt,
            targetKnee: ptAudit.targetKneeGatch,
            angleKey,
          });
        }
      }

      if (ptMaintained >= ptInterval) {
        if (!isCritActive && ptSnooze === 0 && ptNextTilt !== pt.inputs.lateralTilt) {
          list.push({
            id: `rep-${pt.id}`,
            patient: pt,
            category: 'reposition',
            tierScore: (ptOverdue > 0 ? 50 : 60) + activeTie,
            title: `${pt.bedNumber} ${pt.patientName} · ${
              ptOverdue > 0 ? `체위변경 지연 ${ptOverdue}분` : '체위변경(몸 돌리기) 필요'
            }`,
            summary: `${formatTiltKo(pt.inputs.lateralTilt)} ${ptMaintained}분 유지 (기준 ${ptInterval}분)`,
            actionLabel: `${formatTiltActionKo(ptNextTilt)} 적용`,
            canHoldReposition: true,
            targetTilt: ptNextTilt,
          });
        } else if (isCritActive && ptSevere && ptSnooze === 0 && ptNextTilt !== pt.inputs.lateralTilt) {
          list.push({
            id: `rep-severe-${pt.id}`,
            patient: pt,
            category: 'reposition',
            tierScore: 45 + activeTie,
            title: `${pt.bedNumber} ${pt.patientName} · 1.5배 초과 체위변경 필요 (${ptOverdue}분 지연)`,
            summary: `기준 ${ptInterval}분 초과 · 의료진 확인 후 ${formatTiltKo(ptNextTilt)} 적용`,
            actionLabel: `${formatTiltActionKo(ptNextTilt)} 적용`,
            canHoldReposition: true,
            isCriticalRepositionOverride: true,
            targetTilt: ptNextTilt,
          });
        } else if (isCritActive) {
          list.push({
            id: `rep-delay-notice-${pt.id}`,
            patient: pt,
            category: 'reposition',
            tierScore: 80 + activeTie,
            title: `${pt.bedNumber} ${pt.patientName} · 체위변경 지연 ${ptOverdue}분(의료진 확인 후 처리)`,
            summary: `${formatTiltKo(pt.inputs.lateralTilt)} ${ptMaintained}분 유지 중`,
            isCriticalDelayedNotice: true,
          });
        }
      }
    }

    return list.sort((a, b) => a.tierScore - b.tierScore);
  }, [patients, activePatient.id, acknowledgedAngleKeys]);

  const topAlert = allAlerts[0] ?? null;
  const remainingAlerts = allAlerts.slice(1);

  const handleTriggerAlertAction = (alert: QueuedAlert) => {
    if (alert.category === 'critical') {
      if (alert.criticalStage === 'alert_required') {
        handleNotifyDoctorCritical(alert.patient);
      } else {
        if (alert.patient.id !== activePatient.id) {
          onSelectPatient(alert.patient.id);
        }
        setRecheckPanelOpen(true);
      }
      return;
    }

    if (alert.category === 'respiratory' && alert.targetAngle !== undefined) {
      handleApplyAngleForPatient(
        alert.patient,
        alert.targetAngle,
        alert.targetRevTilt,
        alert.angleKey
      );
      return;
    }

    if (alert.category === 'reposition' && alert.targetTilt) {
      if (alert.isCriticalRepositionOverride) {
        const critSt = normalizeCriticalAlertState(alert.patient.criticalAlert).stage;
        const alreadyAlerted =
          critSt === 'awaiting_order' ||
          critSt === 'observing' ||
          critSt === 'continuous_observation' ||
          (alert.patient.id === activePatient.id && doctorNotified);
        if (!alreadyAlerted || !stickyCriticalTiltChecked) return;
      }
      applyLateralTiltForPatient(
        alert.patient,
        alert.targetTilt,
        alert.isCriticalRepositionOverride ? '1.5배 지연 의료진 확인' : '상단 알림 적용'
      );
    }
  };

  // 현재 시각화용 수치 계산
  const displayKnee =
    plannedHobInput > 30 ? (hasPressureRisk ? 15 : 12) : 0;
  const displayRevTilt =
    inputs.spinalOrHipContraindication && inputs.currentHob === 0
      ? liveDecision.reverseTrendelenburgDeg
      : 0;
  const displayTripod = plannedHobInput >= 80 && liveDecision.tripodSupport;
  const displayLegRaise =
    plannedHobInput === 0 && liveDecision.legRaiseDeg > 0 ? liveDecision.legRaiseDeg : 0;
  const displaySeverity =
    activeVitalStatus.level === 'critical'
      ? 'critical'
      : activeRuleConflicts.length > 0 || activeVitalStatus.level === 'caution'
        ? 'caution'
        : liveDecision.severity;

  const holdTargetPatient =
    patients.find((p) => p.id === holdTargetPatientId) ?? null;

  const recommendedAngleText =
    recommendedForPatient.reverseTrendelenburgDeg > 0
      ? `침대 전체 +${recommendedForPatient.reverseTrendelenburgDeg}° (등받이 0°)`
      : activeVitalStatus.level === 'critical' &&
          recommendedForPatient.recommendedHob === Math.round(inputs.currentHob / 5) * 5
        ? `현재 각도(${recommendedForPatient.recommendedHob}°) 유지`
        : `${recommendedForPatient.recommendedHob}°`;

  const applyButtonDisabled =
    activeVitalStatus.level === 'critical' && (!criticalDoctorNotified || !criticalApplyConfirmed);

  const totalProgressScale = Math.max(1, repositionIntervalMinutes, currentRepositionMinutes);
  const normalProgressPct =
    (Math.min(currentRepositionMinutes, repositionIntervalMinutes) / totalProgressScale) * 100;
  const overdueProgressPct = (overdueMinutes / totalProgressScale) * 100;

  // 위험 알림(알리기 / 지시 입력 대기)일 때만 시간 버튼 비활성화, 체위변경 제안은 계속 흐름
  const isTimeBlockedByCritical =
    effectiveCriticalAlert.stage === 'alert_required' ||
    effectiveCriticalAlert.stage === 'awaiting_order';

  return (
    <div className="space-y-4">
      {/* ① 상단 고정 알림 바 (1개만 표시 · 불투명 배경으로 스크롤 시 뒤 내용 비치지 않음) */}
      <div
        ref={alertBarRef}
        className="sticky top-16 z-20 bg-slate-50 pt-1 pb-2 -mt-1 space-y-2"
      >
        {topAlert ? (
          <div
            role="status"
            className={`rounded-lg border px-4 py-2.5 shadow-sm transition-colors ${
              topAlert.category === 'critical' || topAlert.isCriticalRepositionOverride
                ? 'bg-red-50 border-red-300 text-red-950'
                : topAlert.category === 'respiratory'
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : overdueMinutes > 0 && topAlert.patient.id === activePatient.id
                    ? 'bg-red-50 border-red-300 text-red-950'
                    : 'bg-amber-50 border-amber-300 text-amber-950'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                  <span>
                    {topAlert.category === 'critical'
                      ? '✖'
                      : topAlert.category === 'respiratory'
                        ? '▲'
                        : '●'}{' '}
                    {topAlert.title}
                  </span>
                  {topAlert.patient.id !== activePatient.id && (
                    <button
                      type="button"
                      onClick={() => onSelectPatient(topAlert.patient.id)}
                      className="text-[11px] font-semibold text-blue-700 hover:underline cursor-pointer"
                    >
                      해당 환자 보기
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-700 truncate mt-0.5">{topAlert.summary}</p>
                {/* 위험 대응 중 체위변경 지연 시 작은 지연 안내 줄 유지 */}
                {isCriticalPriorityActive && currentRepositionMinutes >= repositionIntervalMinutes && (
                  <p className="text-[11px] font-semibold text-red-700 mt-0.5">
                    체위변경 지연 {overdueMinutes}분(의료진 확인 후 처리)
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {topAlert.isCriticalRepositionOverride && (
                  <label className="flex items-center gap-1.5 text-[11px] font-semibold text-red-900 bg-white border border-red-200 rounded px-2 py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stickyCriticalTiltChecked}
                      onChange={(e) => setStickyCriticalTiltChecked(e.target.checked)}
                      className="w-3.5 h-3.5 accent-red-600 cursor-pointer"
                    />
                    <span>의료진 확인</span>
                  </label>
                )}

                {topAlert.actionLabel && !topAlert.isCriticalDelayedNotice && (
                  <button
                    type="button"
                    disabled={
                      Boolean(topAlert.isCriticalRepositionOverride) &&
                      (!stickyCriticalTiltChecked ||
                        (normalizeCriticalAlertState(topAlert.patient.criticalAlert).stage ===
                          'alert_required' &&
                          !(topAlert.patient.id === activePatient.id && doctorNotified)))
                    }
                    onClick={() => handleTriggerAlertAction(topAlert)}
                    className={`px-3.5 py-2 text-xs font-semibold rounded-md whitespace-nowrap shrink-0 transition-colors ${
                      Boolean(topAlert.isCriticalRepositionOverride) &&
                      (!stickyCriticalTiltChecked ||
                        (normalizeCriticalAlertState(topAlert.patient.criticalAlert).stage ===
                          'alert_required' &&
                          !(topAlert.patient.id === activePatient.id && doctorNotified)))
                        ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                        : topAlert.category === 'critical'
                          ? 'bg-red-600 hover:bg-red-700 text-white cursor-pointer'
                          : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
                    }`}
                  >
                    {topAlert.actionLabel}
                  </button>
                )}

                {topAlert.canHoldReposition && (
                  <button
                    type="button"
                    onClick={() =>
                      setHoldTargetPatientId((prev) =>
                        prev === topAlert.patient.id ? null : topAlert.patient.id
                      )
                    }
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 underline px-1.5 py-1 cursor-pointer whitespace-nowrap"
                  >
                    보류
                  </button>
                )}

                {topAlert.category === 'respiratory' && topAlert.angleKey && (
                  <button
                    type="button"
                    onClick={() =>
                      setAcknowledgedAngleKeys((prev) => ({
                        ...prev,
                        [topAlert.patient.id]: topAlert.angleKey!,
                      }))
                    }
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 underline px-1.5 py-1 cursor-pointer whitespace-nowrap"
                  >
                    보류
                  </button>
                )}

                {remainingAlerts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAlertStackOpen((v) => !v)}
                    className="px-2.5 py-1.5 text-[11px] font-semibold bg-white border border-slate-300 hover:bg-slate-100 text-slate-800 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    알림 +{remainingAlerts.length}
                  </button>
                )}
              </div>
            </div>

            {/* (11)③ '보류' 클릭 시 사유 칩 4개 한 번에 표시 → 클릭 시 즉시 저장 + 15분 뒤 재알림 */}
            {holdTargetPatient && (
              <div className="mt-2 pt-2 border-t border-slate-200/80 flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-700">
                  보류 사유 (누르면 즉시 저장 · 15분 뒤 재알림):
                </span>
                {HOLD_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => handleHoldRepositionForPatient(holdTargetPatient, chip)}
                    className="px-2.5 py-1 text-xs font-semibold bg-white hover:bg-blue-50 text-slate-800 border border-slate-300 hover:border-blue-400 rounded-md cursor-pointer"
                  >
                    {chip}
                  </button>
                ))}
                <input
                  type="text"
                  value={customHoldReason}
                  onChange={(e) => setCustomHoldReason(e.target.value)}
                  placeholder="기타 사유 직접 입력(선택)"
                  aria-label="기타 보류 사유"
                  className="px-2.5 py-1 text-xs bg-white border border-slate-300 rounded text-slate-800 focus:outline-none focus:border-blue-600 min-w-[140px]"
                />
              </div>
            )}

            {/* '알림 +N' 클릭 시 나머지 알림 목록 */}
            {alertStackOpen && remainingAlerts.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200/80 space-y-1.5">
                {remainingAlerts.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 bg-white/90 border border-slate-200 rounded px-3 py-1.5 text-xs"
                  >
                    <span className="font-medium text-slate-800 truncate">
                      {item.title} — <span className="text-slate-500">{item.summary}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectPatient(item.patient.id);
                        setAlertStackOpen(false);
                      }}
                      className="text-[11px] font-semibold text-blue-700 hover:underline shrink-0 cursor-pointer"
                    >
                      이동
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 shadow-sm px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-950">
            <span className="font-semibold">
              ● 긴급 알림 없음 · 모든 환자(가상 데이터) 안정 유지 중
            </span>
            <span className="text-[11px] text-emerald-800">
              {activePatient.bedNumber} {activePatient.patientName} · 모든 변경은 간호사 확인 후 적용
            </span>
          </div>
        )}
      </div>

      {/* 위험 대응 입력 & 재측정 패널 (지시 입력 / 관찰 중 재측정 / 호전 종료 시에만 컴팩트 표시) */}
      {(effectiveCriticalAlert.stage === 'awaiting_order' ||
        effectiveCriticalAlert.stage === 'observing' ||
        effectiveCriticalAlert.stage === 'continuous_observation' ||
        effectiveCriticalAlert.stage === 'resolved' ||
        recheckPanelOpen) && (
        <section
          aria-label="위험 대응 및 재측정"
          className={`rounded-lg border p-4 space-y-3 ${
            effectiveCriticalAlert.stage === 'resolved'
              ? 'bg-emerald-50 border-emerald-300'
              : effectiveCriticalAlert.stage === 'idle'
                ? 'bg-white border-slate-200'
                : 'bg-amber-50 border-amber-300'
          }`}
        >
          {effectiveCriticalAlert.stage === 'awaiting_order' && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-amber-950">
                  ● {effectiveCriticalAlert.alertedAtClock} 의료진 알림 완료 — 지시·처치 입력
                </span>
                <span className="text-[11px] text-slate-600">입력 후 처치 중 관찰 상태로 전환</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={orderNoteInput}
                  onChange={(e) => setOrderNoteInput(e.target.value)}
                  placeholder="처치 내용 메모 (예: 산소 2L 증량 후 15분 관찰)"
                  aria-label="처치 내용 메모"
                  className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded text-slate-900 focus:outline-none focus:border-blue-600"
                />
                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  {[null, 15, 30, 45, 60].map((deg) => (
                    <button
                      key={deg === null ? 'keep' : deg}
                      type="button"
                      onClick={() => setOrderHobInput(deg)}
                      className={`px-2.5 py-1.5 text-[11px] font-mono rounded border cursor-pointer ${
                        orderHobInput === deg
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      {deg === null ? `유지(${inputs.currentHob}°)` : `${deg}°`}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => handleSubmitDoctorOrder()}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md cursor-pointer"
                  >
                    지시 저장
                  </button>
                </div>
              </div>
            </div>
          )}

          {effectiveCriticalAlert.seniorEscalationShown &&
            !effectiveCriticalAlert.seniorEscalationAcknowledged &&
            (effectiveCriticalAlert.stage === 'observing' ||
              effectiveCriticalAlert.stage === 'continuous_observation') && (
              <div className="bg-red-100 border border-red-300 rounded p-3 flex flex-wrap items-center justify-between gap-2 text-xs text-red-900">
                <span>
                  <strong>▲ 호전 없음 {effectiveCriticalAlert.noImprovementCount}회(가정값)</strong>{' '}
                  — 상급 의료진·신속대응 요청을 고려하세요.
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onUpdatePatient({
                      ...activePatient,
                      criticalAlert: {
                        ...effectiveCriticalAlert,
                        seniorEscalationAcknowledged: true,
                      },
                    })
                  }
                  className="px-3 py-1 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded cursor-pointer"
                >
                  확인 · 지속 관찰 유지
                </button>
              </div>
            )}

          {(effectiveCriticalAlert.stage === 'observing' ||
            effectiveCriticalAlert.stage === 'continuous_observation' ||
            (recheckPanelOpen &&
              effectiveCriticalAlert.stage !== 'awaiting_order' &&
              effectiveCriticalAlert.stage !== 'resolved')) && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-bold text-slate-900">
                  {effectiveCriticalAlert.stage === 'continuous_observation'
                    ? `● 지시 대기·지속 관찰 (호전 없음 ${effectiveCriticalAlert.noImprovementCount}회)`
                    : effectiveCriticalAlert.stage === 'observing'
                      ? `● 처치 중 관찰 (${effectiveCriticalAlert.doctorOrderNote || '관찰 중'}) · 안정 ${effectiveCriticalAlert.consecutiveSafeRechecks}/2회`
                      : '재측정 수치 입력'}
                </div>
                {recheckPanelOpen && effectiveCriticalAlert.stage === 'idle' && (
                  <button
                    type="button"
                    onClick={() => setRecheckPanelOpen(false)}
                    className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                  >
                    닫기
                  </button>
                )}
              </div>

              {virtualMode && lastSimRecoveryBadge && (
                <div className="text-xs text-blue-900 bg-blue-50 border border-blue-200 rounded px-3 py-1.5">
                  {lastSimRecoveryBadge}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2.5 items-end">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    호흡수 (회/분)
                  </label>
                  <input
                    type="number"
                    min={4}
                    max={50}
                    value={recheckInputs.rr}
                    onChange={(e) =>
                      setRecheckInputs((v) => ({ ...v, rr: Number(e.target.value) || 0 }))
                    }
                    className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    맥박수 (회/분)
                  </label>
                  <input
                    type="number"
                    min={20}
                    max={200}
                    value={recheckInputs.hr}
                    onChange={(e) =>
                      setRecheckInputs((v) => ({ ...v, hr: Number(e.target.value) || 0 }))
                    }
                    className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    산소포화도 (SpO2 %)
                  </label>
                  <input
                    type="number"
                    min={60}
                    max={100}
                    value={recheckInputs.spo2}
                    onChange={(e) =>
                      setRecheckInputs((v) => ({ ...v, spo2: Number(e.target.value) || 0 }))
                    }
                    className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="flex items-center gap-2">
                  {(effectiveCriticalAlert.stage === 'observing' ||
                    effectiveCriticalAlert.stage === 'continuous_observation') && (
                    <button
                      type="button"
                      onClick={() => handleSubmitCriticalRecheck('unchanged')}
                      className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-md whitespace-nowrap cursor-pointer"
                    >
                      변화 없음
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleSubmitCriticalRecheck('manual')}
                    className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap cursor-pointer"
                  >
                    재측정 기록
                  </button>
                </div>
              </div>
            </div>
          )}

          {effectiveCriticalAlert.stage === 'resolved' && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-emerald-800">
                ● 호전 시 종료 ({effectiveCriticalAlert.lastRecheckAtClock}) — 2회 연속 안정 확인
                (체위변경 숨김 자동 해제됨)
              </span>
              <button
                type="button"
                onClick={() =>
                  onUpdatePatient({
                    ...activePatient,
                    criticalAlert: DEFAULT_CRITICAL_ALERT_STATE,
                  })
                }
                className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 rounded cursor-pointer"
              >
                종료 확인
              </button>
            </div>
          )}
        </section>
      )}

      {/* ② 환자 선택 카드 (카드당 정보 4개 이하: 병실·이름 / 상태 / 1줄 수치 요약 / 체위변경 배지) */}
      <section aria-label="환자 선택 카드">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {patients.map((pt) => {
            const ptVs = evaluatePatientVitalStatus(pt.inputs);
            const isSelected = pt.id === activePatient.id;
            const ptElapsed = Math.max(0, pt.elapsedMinutes ?? 0);
            const ptStart = Math.max(0, Math.min(pt.repositionStartedAtElapsed ?? 0, ptElapsed));
            const ptMaintained = Math.max(0, ptElapsed - ptStart);
            const ptInterval =
              pt.customRepositionIntervalMin ?? getDefaultRepositionInterval(pt.inputs);
            const ptOverdue = Math.max(0, ptMaintained - ptInterval);
            const ptSnooze = pt.repositionSnoozeMinutesLeft ?? 0;

            const statusColor =
              ptVs.level === 'critical'
                ? 'text-red-700'
                : ptVs.level === 'caution'
                  ? 'text-amber-700'
                  : 'text-emerald-700';

            const repositionBadgeText =
              ptOverdue > 0
                ? `지연 ${ptOverdue}분`
                : ptMaintained >= ptInterval
                  ? '자세 변경 필요'
                  : ptSnooze > 0
                    ? `보류 ${ptSnooze}분`
                    : `체위 ${ptInterval - ptMaintained}분 남음`;

            const repositionBadgeClass =
              ptOverdue > 0
                ? 'bg-red-50 text-red-700 border-red-200 font-semibold'
                : ptMaintained >= ptInterval || ptSnooze > 0
                  ? 'bg-amber-50 text-amber-800 border-amber-200 font-semibold'
                  : 'bg-slate-50 text-slate-600 border-slate-200';

            return (
              <button
                key={pt.id}
                type="button"
                onClick={() => onSelectPatient(pt.id)}
                className={`text-left p-3.5 rounded-lg border transition-colors cursor-pointer space-y-1.5 ${
                  isSelected
                    ? 'bg-white border-blue-600 ring-1 ring-blue-600'
                    : 'bg-white border-slate-200 hover:border-slate-300'
                }`}
              >
                {/* 항목 1 & 2: 병실·이름 + 상태 색·짧은 문구 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-slate-900 truncate">
                    {pt.bedNumber} · {pt.patientName}
                  </span>
                  <span className={`text-xs font-bold shrink-0 ${statusColor}`}>
                    {ptVs.glyph} {ptVs.label}
                  </span>
                </div>

                {/* 항목 3: 한 줄 수치 요약 */}
                <div className="text-xs font-mono tabular-nums text-slate-600 truncate">
                  {pt.inputs.currentHob}° · 호흡 {pt.inputs.rr} · 맥박 {pt.inputs.hr} · 산소{' '}
                  {pt.inputs.spo2}%
                </div>

                {/* 항목 4: 체위변경 상태 배지 */}
                <div>
                  <span
                    className={`inline-block text-[11px] font-mono tabular-nums px-2 py-0.5 rounded border ${repositionBadgeClass}`}
                  >
                    {repositionBadgeText}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* (1)~(6) 얇은 시뮬레이션 바 (항상 표시 · 스크롤 시 알림 바 바로 아래에 가볍게 고정) */}
      <section
        aria-label="시뮬레이션 바"
        style={{ top: `${64 + alertBarHeight}px` }}
        className="md:sticky z-10 bg-white border border-slate-200 rounded-lg px-3.5 py-2 shadow-xs flex flex-wrap items-center justify-between gap-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* 1. 가상 모드 토글 */}
          <button
            type="button"
            onClick={() => {
              setVirtualMode((v) => !v);
              setLastSimRecoveryBadge(null);
            }}
            className={`px-2.5 py-1 font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              virtualMode
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
            }`}
          >
            가상 모드: {virtualMode ? '켜짐' : '꺼짐'}
          </button>

          {virtualMode && (
            <span className="font-semibold text-blue-700 whitespace-nowrap shrink-0">
              가상 시뮬레이션
            </span>
          )}

          {/* 2. ▷ 시간 흐르기 / ⏸ 멈춤 */}
          <button
            type="button"
            disabled={!timeFlowPlaying && isTimeBlockedByCritical}
            onClick={handleToggleTimeFlow}
            className={`px-2.5 py-1 font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              timeFlowPlaying
                ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                : 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed'
            }`}
          >
            {timeFlowPlaying ? '⏸ 멈춤' : '▷ 시간 흐르기'}
          </button>

          {/* 3. 속도 칩 (×1, ×10, ×60) */}
          <div
            role="group"
            aria-label="시간 흐름 속도"
            className="inline-flex items-center rounded border border-slate-200 bg-slate-50 p-0.5 shrink-0"
          >
            {(
              [
                [1, '×1', '1초에 1분'],
                [10, '×10', '1초에 10분'],
                [60, '×60', '1초에 1시간'],
              ] as const
            ).map(([spd, label, desc]) => (
              <button
                key={spd}
                type="button"
                title={desc}
                onClick={() => setTimeSpeed(spd)}
                className={`px-2 py-0.5 font-mono font-semibold rounded transition-colors whitespace-nowrap cursor-pointer ${
                  timeSpeed === spd
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 4. +15분 / +30분 / +1시간 (자동 재생 중에도 활성) */}
          <div className="flex items-center gap-1 shrink-0">
            {(
              [
                [15, '+15분'],
                [30, '+30분'],
                [60, '+1시간'],
              ] as const
            ).map(([mins, label]) => (
              <button
                key={mins}
                type="button"
                disabled={isTimeBlockedByCritical}
                onClick={() => advanceTimeBy(mins)}
                className="px-2 py-1 font-mono font-semibold bg-slate-50 hover:bg-blue-50 hover:text-blue-700 text-slate-800 border border-slate-200 hover:border-blue-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200 disabled:cursor-not-allowed rounded whitespace-nowrap cursor-pointer"
              >
                {label}
              </button>
            ))}
          </div>

          {/* 5. 처음으로 (자동 재생 중에도 활성) */}
          <button
            type="button"
            onClick={() => setResetConfirmOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>처음으로</span>
          </button>
        </div>

        {/* 6. 누적 경과 시간 + 상태 안내 */}
        <div className="flex flex-wrap items-center gap-2">
          {stoppedByAlertNotice && (
            <span className="text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 whitespace-nowrap">
              알림이 떠서 멈췄어요
            </span>
          )}
          {isTimeBlockedByCritical && (
            <span className="text-[11px] font-semibold text-red-700 whitespace-nowrap">
              알림 확인 후 시간이 흐릅니다
            </span>
          )}
          <span className="font-mono tabular-nums text-slate-700 whitespace-nowrap">
            누적 <strong className="text-slate-900">{formatElapsed(elapsedMinutes)}</strong> (
            {formatClockFromElapsed(elapsedMinutes)})
          </span>
        </div>
      </section>

      {/* ③ 수치 입력 영역 (슬라이더 + 입력칸 한 화면에 컴팩트하게) */}
      <section
        aria-label="수치 입력 영역"
        className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              {activePatient.bedNumber} {activePatient.patientName} — 수치 입력 (활력징후)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {activePatient.diagnosis} · 평균동맥압 (MAP) {mapValue} mmHg ·{' '}
              <span
                className={
                  activeVitalStatus.level === 'critical'
                    ? 'text-red-700 font-semibold'
                    : activeVitalStatus.level === 'caution'
                      ? 'text-amber-700 font-semibold'
                      : 'text-emerald-700 font-semibold'
                }
              >
                {activeVitalStatus.label}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRecheckPanelOpen((v) => !v)}
            className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-md cursor-pointer"
          >
            재측정 기록
          </button>
        </div>

        {activeRuleConflicts.length > 0 && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 rounded-md px-3.5 py-2 text-xs text-red-900 font-medium"
          >
            ▲ 규칙 충돌: {activeRuleConflicts[0]}
          </div>
        )}

        {/* 슬라이더 + 숫자 입력칸 3열 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="rr-slider" className="font-semibold text-slate-800">
                1분 호흡수 (RR)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={6}
                  max={38}
                  value={inputs.rr}
                  aria-label="1분 호흡수 숫자"
                  onChange={(e) => updateField('rr', Number(e.target.value) || 0)}
                  className="w-14 px-1.5 py-0.5 text-right text-xs font-mono tabular-nums font-bold bg-slate-50 border border-slate-200 rounded"
                />
                <span className="text-[11px] text-slate-400">회</span>
              </div>
            </div>
            <input
              id="rr-slider"
              type="range"
              min={6}
              max={38}
              value={inputs.rr}
              onChange={(e) => updateField('rr', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="hr-slider" className="font-semibold text-slate-800">
                1분 맥박수 (HR)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={38}
                  max={150}
                  value={inputs.hr}
                  aria-label="1분 맥박수 숫자"
                  onChange={(e) => updateField('hr', Number(e.target.value) || 0)}
                  className="w-14 px-1.5 py-0.5 text-right text-xs font-mono tabular-nums font-bold bg-slate-50 border border-slate-200 rounded"
                />
                <span className="text-[11px] text-slate-400">회</span>
              </div>
            </div>
            <input
              id="hr-slider"
              type="range"
              min={38}
              max={150}
              value={inputs.hr}
              onChange={(e) => updateField('hr', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="spo2-slider" className="font-semibold text-slate-800">
                산소포화도 (SpO2)
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={80}
                  max={100}
                  value={inputs.spo2}
                  aria-label="산소포화도 숫자"
                  onChange={(e) => updateField('spo2', Number(e.target.value) || 0)}
                  className="w-14 px-1.5 py-0.5 text-right text-xs font-mono tabular-nums font-bold bg-slate-50 border border-slate-200 rounded"
                />
                <span className="text-[11px] text-slate-400">%</span>
              </div>
            </div>
            <input
              id="spo2-slider"
              type="range"
              min={80}
              max={100}
              value={inputs.spo2}
              onChange={(e) => updateField('spo2', Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>
        </div>

        {/* 혈압 · 숨참 · 통증 · 피부 상태 5열 */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div>
            <label htmlFor="sbp-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
              최고 혈압 (SBP)
            </label>
            <input
              id="sbp-input"
              type="number"
              min={60}
              max={220}
              value={inputs.sbp}
              onChange={(e) => updateField('sbp', Number(e.target.value) || 0)}
              className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums font-semibold bg-slate-50 border border-slate-200 rounded-md"
            />
          </div>
          <div>
            <label htmlFor="dbp-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
              최저 혈압 (DBP)
            </label>
            <input
              id="dbp-input"
              type="number"
              min={30}
              max={140}
              value={inputs.dbp}
              onChange={(e) => updateField('dbp', Number(e.target.value) || 0)}
              className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums font-semibold bg-slate-50 border border-slate-200 rounded-md"
            />
          </div>
          <div>
            <label htmlFor="borg-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
              숨찬 정도 (0~10)
            </label>
            <input
              id="borg-input"
              type="number"
              min={0}
              max={10}
              value={inputs.borgScore}
              onChange={(e) =>
                updateField('borgScore', Math.max(0, Math.min(10, Number(e.target.value) || 0)))
              }
              className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums font-semibold bg-slate-50 border border-slate-200 rounded-md"
            />
          </div>
          <div>
            <label htmlFor="pain-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
              아픈 정도 (NRS)
            </label>
            <input
              id="pain-input"
              type="number"
              min={0}
              max={10}
              value={inputs.painNrs}
              onChange={(e) =>
                updateField('painNrs', Math.max(0, Math.min(10, Number(e.target.value) || 0)))
              }
              className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums font-semibold bg-slate-50 border border-slate-200 rounded-md"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label htmlFor="skin-select" className="block text-[11px] font-semibold text-slate-700 mb-1">
              엉치뼈 피부 상태
            </label>
            <select
              id="skin-select"
              value={inputs.sacralSkinStatus}
              onChange={(e) => updateField('sacralSkinStatus', e.target.value as SacralSkinStatus)}
              className="w-full px-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-800"
            >
              <option value="intact">깨끗함</option>
              <option value="blanchable_erythema">붉게 눌림 (주의)</option>
              <option value="ulcer_stage2_plus">욕창 상처 (제한)</option>
            </select>
          </div>
        </div>

        {/* 환자 특이사항 체크박스 */}
        <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1.5">
          {(
            [
              ['enteralNutrition', '콧줄 식사 (30° 이상)'],
              ['heartFailureOrPulmonaryEdema', '심부전·폐부종 (폐에 물)'],
              ['orthostaticHistory', '기립성 저혈압 이력'],
              ['pressureInjuryHighRisk', '엉치뼈 욕창 고위험'],
              ['iicpRisk', '뇌압 (IICP) 상승 주의'],
              ['spinalOrHipContraindication', '허리·고관절 굽힘 금지'],
              ['copdTargetMode', '만성 폐질환 (COPD)'],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none py-0.5"
            >
              <input
                type="checkbox"
                checked={inputs[key]}
                onChange={(e) => updateField(key, e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 cursor-pointer"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* ④ '추천 각도 ○° (무릎 받침 ○°)' 한 줄 + 큰 '적용' 버튼 (원클릭 적용 + 3초 토스트) */}
      <section
        aria-label="추천 각도 및 적용"
        className={`rounded-lg border p-5 space-y-4 ${
          activeVitalStatus.level === 'critical'
            ? 'bg-red-50/50 border-red-300'
            : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="text-lg font-bold text-slate-900">
              추천 각도{' '}
              <span className="font-mono tabular-nums text-blue-700">{recommendedAngleText}</span>
              {recommendedForPatient.recommendedKneeGatch > 0 && (
                <span className="font-mono tabular-nums text-slate-700">
                  {' '}
                  (무릎 받침 {recommendedForPatient.recommendedKneeGatch}°)
                </span>
              )}
            </div>
            <p className="text-xs text-slate-600 line-clamp-2">
              {recommendedForPatient.shortReason}
            </p>
          </div>

          <button
            type="button"
            disabled={applyButtonDisabled}
            onClick={() =>
              handleApplyAngleForPatient(
                activePatient,
                plannedHobInput,
                displayRevTilt > 0 ? displayRevTilt : 0
              )
            }
            className={`px-7 py-3 text-sm font-bold rounded-lg whitespace-nowrap shrink-0 transition-colors ${
              applyButtonDisabled
                ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                : activeVitalStatus.level === 'critical'
                  ? 'bg-red-600 hover:bg-red-700 text-white cursor-pointer'
                  : 'bg-blue-600 hover:bg-blue-700 text-white cursor-pointer'
            }`}
          >
            {displayRevTilt > 0 ? `침대 전체 +${displayRevTilt}° 적용` : `${plannedHobInput}° 적용`}
          </button>
        </div>

        {/* 위험 상태일 때만 의료진 확인 요구 */}
        {activeVitalStatus.level === 'critical' && (
          <div className="bg-white border border-red-200 rounded-md p-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-red-900 cursor-pointer">
              <input
                type="checkbox"
                checked={criticalApplyConfirmed}
                onChange={(e) => setCriticalApplyConfirmed(e.target.checked)}
                className="w-4 h-4 accent-red-600 cursor-pointer"
              />
              <span>위험 상태: 의료진 확인 후 각도를 적용합니다</span>
            </label>
            {!criticalDoctorNotified ? (
              <button
                type="button"
                onClick={() => handleNotifyDoctorCritical(activePatient)}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
              >
                먼저 의료진에게 알리기
              </button>
            ) : (
              <span className="text-xs font-semibold text-emerald-700">● 의료진 알림 완료</span>
            )}
          </div>
        )}

        {/* 각도 미세 조정 슬라이더 + 빠른 버튼 */}
        <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 flex-1">
            <span className="text-xs font-semibold text-slate-700 whitespace-nowrap">
              적용 각도 ({plannedHobInput}°):
            </span>
            <input
              type="range"
              min={0}
              max={90}
              step={1}
              value={plannedHobInput}
              aria-label="등받이 각도 조절"
              onChange={(e) => setPlannedHobInput(Number(e.target.value))}
              className="flex-1 accent-blue-600 cursor-pointer"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {QUICK_ANGLES.map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setPlannedHobInput(deg)}
                className={`px-2 py-1 text-xs font-mono tabular-nums rounded border cursor-pointer ${
                  plannedHobInput === deg
                    ? 'bg-blue-600 text-white border-blue-600 font-semibold'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {deg}°
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ⑤ 현재 상태 요약 & 통합 타이머 카드 (현재 각도, 자세, 다음 체위변경까지 ○분 + 가는 진행 막대) */}
      <section
        aria-label="현재 상태 요약"
        className={`rounded-lg border p-5 space-y-3 ${
          overdueMinutes > 0 || repeatedHoldWarning
            ? 'bg-red-50/50 border-red-300'
            : repositionAlertDue
              ? 'bg-amber-50/60 border-amber-300'
              : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <div>
              <span className="text-xs text-slate-500 mr-1.5">현재 각도</span>
              <strong className="font-mono tabular-nums text-slate-900">
                {inputs.currentHob}°
              </strong>
              {inputs.currentHob >= 30 && inputs.currentHob <= 45 && (
                <span className="text-xs text-slate-500 ml-1">반좌위(상체 세움)</span>
              )}
            </div>
            <div>
              <span className="text-xs text-slate-500 mr-1.5">자세</span>
              <strong className="text-slate-900">{formatTiltKo(inputs.lateralTilt)}</strong>
              <span className="text-xs text-slate-500 ml-1.5">
                · {formatRepositionAgoLabel(currentRepositionMinutes, inputs.lateralTilt)}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 mr-1.5">체위변경(몸 돌리기)</span>
              <strong
                className={`font-mono tabular-nums ${
                  overdueMinutes > 0
                    ? 'text-red-700'
                    : repositionAlertDue
                      ? 'text-amber-800'
                      : 'text-blue-700'
                }`}
              >
                {overdueMinutes > 0
                  ? `지연 ${overdueMinutes}분`
                  : repositionSnoozeLeft > 0
                    ? `보류 재알림 ${repositionSnoozeLeft}분`
                    : remainingToReposition === 0
                      ? '변경 필요 (도달)'
                      : `다음 체위변경까지 ${remainingToReposition}분`}
              </strong>
              <span className="text-xs text-slate-500 ml-1.5">
                (다음: {formatTiltKo(nextCycleTilt)})
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {(
              [
                ['left_30', '왼쪽 30°'],
                ['center', '정면'],
                ['right_30', '오른쪽 30°'],
              ] as const
            ).map(([tiltKey, label]) => (
              <button
                key={tiltKey}
                type="button"
                onClick={() => handleLateralReposition(tiltKey)}
                className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                  inputs.lateralTilt === tiltKey
                    ? 'bg-blue-600 text-white border-blue-600 font-semibold'
                    : nextCycleTilt === tiltKey
                      ? 'bg-blue-50 text-blue-800 border-blue-300 font-semibold'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 가는 진행 막대 + 한 줄 상태 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs font-mono tabular-nums">
            <span className={overdueMinutes > 0 ? 'text-red-700 font-semibold' : 'text-slate-600'}>
              {overdueMinutes > 0
                ? `${currentRepositionMinutes}분 / ${repositionIntervalMinutes}분 · ${overdueMinutes}분 지연`
                : `다음 체위변경까지 ${remainingToReposition}분 (${currentRepositionMinutes}/${repositionIntervalMinutes}분)`}
            </span>
            {repeatedHoldWarning && (
              <span className="text-red-700 font-semibold">
                반복 보류 {repositionHoldCount}회 — 확인 필요
              </span>
            )}
          </div>
          <div
            className="w-full h-2 bg-slate-200/80 rounded-full overflow-hidden flex"
            role="progressbar"
            aria-valuenow={currentRepositionMinutes}
            aria-valuemin={0}
            aria-valuemax={totalProgressScale}
          >
            <div
              className={`h-full transition-all duration-300 ${
                overdueMinutes > 0
                  ? 'bg-amber-500 border-r border-white'
                  : repositionAlertDue
                    ? 'bg-amber-500'
                    : 'bg-blue-600'
              }`}
              style={{ width: `${normalProgressPct}%` }}
            />
            {overdueProgressPct > 0 && (
              <div
                className="h-full bg-red-600 transition-all duration-300"
                style={{ width: `${overdueProgressPct}%` }}
              />
            )}
          </div>
        </div>

        {/* 위험 상태에서 직접 돌아눕기 클릭 시 의료진 확인 요청 */}
        {pendingLateralTilt && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 space-y-2 text-xs">
            <div className="font-semibold text-red-900">
              ✖ 위험 상태 확인 필요 ({formatTiltKo(pendingLateralTilt)}): 의료진 확인 후 몸을 돌릴 수 있습니다.
            </div>
            <label className="flex items-center gap-2 text-slate-900 font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={pendingLateralSafetyChecked}
                onChange={(e) => setPendingLateralSafetyChecked(e.target.checked)}
                className="w-4 h-4 accent-red-600 cursor-pointer"
              />
              <span>위험 처치 중 체위변경 가능 여부를 의료진에게 확인했습니다</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {!criticalDoctorNotified && (
                <button
                  type="button"
                  onClick={() => handleNotifyDoctorCritical(activePatient)}
                  className="px-3 py-1 bg-red-600 text-white font-semibold rounded cursor-pointer"
                >
                  먼저 의료진에게 알리기
                </button>
              )}
              <button
                type="button"
                disabled={!criticalDoctorNotified || !pendingLateralSafetyChecked}
                onClick={() => handleConfirmCriticalLateral(true)}
                className={`px-3 py-1 font-semibold rounded ${
                  criticalDoctorNotified && pendingLateralSafetyChecked
                    ? 'bg-blue-600 text-white cursor-pointer'
                    : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                }`}
              >
                돌아눕기 적용
              </button>
              <button
                type="button"
                onClick={() => handleConfirmCriticalLateral(false)}
                className="px-2.5 py-1 bg-white border border-slate-300 text-slate-700 rounded cursor-pointer"
              >
                취소
              </button>
            </div>
          </div>
        )}
      </section>

      {/* (3) 그래프 · 그림 보기 (접이식 영역) */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <button
          type="button"
          onClick={() => setShowVisuals((v) => !v)}
          className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors rounded-lg cursor-pointer"
        >
          <div>
            <span className="text-sm font-bold text-slate-900">그래프 · 그림 보기</span>
            <span className="ml-2 text-xs text-slate-500">
              침대 각도·돌아눕기 그림과 호흡·맥박·산소 변화 그래프
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 shrink-0">
            <span>{showVisuals ? '접기' : '펼쳐보기'}</span>
            {showVisuals ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        </button>

        {showVisuals && (
          <div className="px-5 pb-5 pt-3 border-t border-slate-200 space-y-5">
            <BedAngleVisualizer
              currentHobAngle={inputs.currentHob}
              hobAngle={plannedHobInput}
              kneeGatchDeg={displayKnee}
              reverseTrendelenburgDeg={displayRevTilt}
              legRaiseDeg={displayLegRaise}
              tripodSupport={displayTripod}
              lateralTilt={inputs.lateralTilt}
              severity={displaySeverity}
            />
            <VitalTrendChart
              history={activePatient.history}
              previewPoint={
                virtualMode && plannedHobInput !== inputs.currentHob
                  ? (() => {
                      const p = simulateVitalsAtAngle(inputs, plannedHobInput);
                      const previewElapsed = getNextUniqueElapsedFor(activePatient, 5);
                      return {
                        timeLabel: formatClockFromElapsed(previewElapsed),
                        rr: p.rr,
                        hr: p.hr,
                        hob: plannedHobInput,
                        spo2: p.spo2,
                        eventType: 'preview',
                        eventLabel: `${plannedHobInput}° 예상`,
                      };
                    })()
                  : null
              }
            />
          </div>
        )}
      </section>

      {/* (2) 자세히 보기 · 더보기 (판정 기준, 근거, 순서·안전수칙, 욕창 예방, 간격 설정, 시연 모드) */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <button
          type="button"
          onClick={() => setShowMoreDetails((v) => !v)}
          className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-50 transition-colors rounded-lg cursor-pointer"
        >
          <div>
            <span className="text-sm font-bold text-slate-900">자세히 보기 · 더보기</span>
            <span className="ml-2 text-xs text-slate-500">
              판정 기준, 추천 근거, 안전 수칙, 체위변경 간격, 시간·위험 시연 모드
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 shrink-0">
            <span>{showMoreDetails ? '접기' : '더보기'}</span>
            {showMoreDetails ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </span>
        </button>

        {showMoreDetails && (
          <div className="px-5 pb-5 pt-4 border-t border-slate-200 space-y-5 text-xs">
            {/* 시연 모드 및 시간 시뮬레이션 */}
            <div className="bg-slate-50 border border-slate-200 rounded-md p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-bold text-slate-900">
                  시연 모드 및 시간 경과 테스트 (누적 {formatElapsed(elapsedMinutes)} ·{' '}
                  {formatClockFromElapsed(elapsedMinutes)})
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={triggerCriticalDemo}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-300 rounded cursor-pointer"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>위험 상황 시연 (맥박 138)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setVirtualMode((v) => !v);
                      setLastSimRecoveryBadge(null);
                    }}
                    className={`px-2.5 py-1.5 font-semibold rounded border cursor-pointer ${
                      virtualMode
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-700 border-slate-300'
                    }`}
                  >
                    가상 모드: {virtualMode ? '켜짐' : '꺼짐'}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!timeFlowPlaying && isTimeBlockedByCritical}
                    onClick={handleToggleTimeFlow}
                    className={`px-3 py-1.5 font-semibold rounded inline-flex items-center gap-1 cursor-pointer ${
                      timeFlowPlaying
                        ? 'bg-slate-900 text-white'
                        : 'bg-blue-600 hover:bg-blue-700 text-white disabled:bg-slate-300 disabled:cursor-not-allowed'
                    }`}
                  >
                    {timeFlowPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    <span>{timeFlowPlaying ? '⏸ 멈춤' : '▷ 시간 흐르기'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isTimeBlockedByCritical}
                    onClick={() => advanceTimeBy(15)}
                    className="px-2.5 py-1.5 font-mono bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed rounded inline-flex items-center gap-1 cursor-pointer"
                  >
                    <FastForward className="w-3 h-3 text-slate-500" />
                    <span>+15분</span>
                  </button>
                  <button
                    type="button"
                    disabled={isTimeBlockedByCritical}
                    onClick={() => advanceTimeBy(30)}
                    className="px-2.5 py-1.5 font-mono bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed rounded cursor-pointer"
                  >
                    +30분
                  </button>
                  <button
                    type="button"
                    disabled={isTimeBlockedByCritical}
                    onClick={() => advanceTimeBy(60)}
                    className="px-2.5 py-1.5 font-mono bg-white border border-slate-200 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed rounded cursor-pointer"
                  >
                    +1시간
                  </button>
                </div>

                <span className="text-[11px] text-slate-600">
                  {virtualMode
                    ? '가상 모드 켜짐: 처치·각도에 따라 수치가 서서히 변함'
                    : '가상 모드 꺼짐: 시간만 흐르고 수치는 고정'}
                </span>
              </div>

              {timeEvents.length > 0 && (
                <ul className="space-y-1 pt-2 border-t border-slate-200">
                  {timeEvents.slice(0, 4).map((ev) => (
                    <li key={ev.id} className="text-slate-700 font-mono">
                      {ev.elapsedLabel} · {ev.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 체위변경 간격 설정 */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <span className="font-semibold text-slate-800">
                체위변경 간격 설정 (일반 120분 · 욕창위험 90분 · 붉게 눌림 60분 — 프로토콜 가정값):
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {[60, 90, 120].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => updateCustomRepositionInterval(preset)}
                    className={`px-2 py-1 font-mono rounded border cursor-pointer ${
                      repositionIntervalMinutes === preset
                        ? 'bg-blue-600 text-white border-blue-600 font-semibold'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    {preset}분
                  </button>
                ))}
                <input
                  type="number"
                  min={15}
                  max={240}
                  step={5}
                  value={repositionIntervalMinutes}
                  aria-label="체위변경 간격(분)"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v > 0) updateCustomRepositionInterval(v);
                  }}
                  className="w-14 px-2 py-1 font-mono tabular-nums border border-slate-200 rounded"
                />
                {isCustomRepositionInterval && (
                  <button
                    type="button"
                    onClick={() => updateCustomRepositionInterval(null)}
                    className="text-blue-700 hover:underline cursor-pointer"
                  >
                    기본값({defaultRepositionInterval}분)
                  </button>
                )}
              </div>
            </div>

            {/* 판정 기준 배너 (교육용 가정값) */}
            <div className="bg-slate-50 border border-slate-200 rounded-md p-3.5 space-y-1">
              <div className="font-bold text-slate-900">판정 기준 (교육용 가정값)</div>
              <div className="font-mono text-[11px] text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  <strong className="text-amber-700">▲ 주의:</strong> 호흡 &gt;20·&lt;12, 맥박
                  &gt;100·&lt;60, 산소 &lt;94%(COPD &lt;88%), 수축기 &lt;90, 평균동맥압(MAP) &lt;65,
                  숨참 ≥8점
                </span>
                <span>
                  <strong className="text-red-700">✖ 위험:</strong> 호흡 ≥30·≤8, 맥박 ≥130·≤45, 산소
                  ≤90%(COPD ≤85%), 수축기 &lt;85, 평균동맥압(MAP) &lt;60
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                본 판정 기준과 유지 시간 제한은 교육용 가정값이며 실제 기준은 병원 프로토콜을 따릅니다.
              </div>
            </div>

            {/* 추천 이유·근거 + 조절 순서·안전 수칙 + 욕창 예방 안내 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="font-bold text-slate-900">추천 이유 · 판정 근거</div>
                <p className="text-slate-700 leading-relaxed">
                  {recommendedForPatient.actionSummary}
                </p>
                <ul className="space-y-1 text-slate-600">
                  {recommendedForPatient.physiologicalRationale.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
                <div className="bg-amber-50 border border-amber-200 rounded p-2.5 text-amber-900">
                  <strong>욕창 예방 안내:</strong> {recommendedForPatient.pressureCareAdvice}
                  {inputs.currentHob > HIGH_ANGLE_HOB_THRESHOLD && (
                    <div className="mt-1 font-mono">
                      45° 초과({inputs.currentHob}°) 유지: {minutesAbove45}분 / 60분 기준(가정값)
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <div className="font-bold text-slate-900">각도 조절 순서 · 안전 수칙</div>
                <ol className="space-y-1 text-slate-700">
                  {recommendedForPatient.stepPlan.map((step, i) => (
                    <li key={i}>
                      <span className="font-mono text-blue-600 font-semibold mr-1.5">
                        0{i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
                {recommendedForPatient.safetyWarnings.length > 0 && (
                  <ul className="space-y-1 text-red-800 bg-red-50 border border-red-200 rounded p-2.5">
                    {recommendedForPatient.safetyWarnings.map((w, i) => (
                      <li key={i}>• {w}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* (10) 필수 안전 규칙 및 가상 데이터·면책 안내 */}
      <div className="text-[11px] text-slate-500 text-center py-1">
        가상 시뮬레이션 데이터 · 위험 시 의료진 알림 우선 · 모든 각도/자세 변경은 간호사 확인 후 적용 · 교육용 가정값이며 실제 기준은 병원 프로토콜을 따릅니다.
      </div>

      {/* 체험 도구 플로팅 버튼 & 슬라이드 패널 (기본 닫힘) */}
      <PracticeToolsDrawer
        activePatient={activePatient}
        effectiveCriticalAlert={effectiveCriticalAlert}
        criticalDoctorNotified={criticalDoctorNotified}
        onRequestReset={() => setResetConfirmOpen(true)}
        onApplyPreset={handleApplyPresetFromPractice}
        onNotifyDoctorCritical={handleNotifyDoctorCritical}
        orderNoteInput={orderNoteInput}
        onChangeOrderNote={setOrderNoteInput}
        orderHobInput={orderHobInput}
        onChangeOrderHob={setOrderHobInput}
        onSubmitDoctorOrder={handleSubmitDoctorOrder}
        recheckInputs={recheckInputs}
        onChangeRecheckInputs={setRecheckInputs}
        onSubmitRecheck={handleSubmitCriticalRecheck}
        onApplyAngleFromPractice={(targetHob, confirmedCritical) =>
          handleApplyAngleForPatient(activePatient, targetHob, 0, undefined, {
            isPractice: true,
            criticalConfirmedOverride: confirmedCritical,
          })
        }
      />

      {/* (5) '처음으로' 초기화 확인 창 */}
      {resetConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/35">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
            className="w-full max-w-sm bg-white border border-slate-200 rounded-lg shadow-xl p-5 space-y-4"
          >
            <div className="space-y-1.5">
              <h3 id="reset-confirm-title" className="text-base font-bold text-slate-900">
                처음 상태로 초기화할까요?
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                모든 환자의 수치, 체위변경 타이머, 그리고 간호 기록함의 체험 기록이 모두
                초기화됩니다.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded-md cursor-pointer"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  setResetConfirmOpen(false);
                  handleResetFromPractice();
                }}
                className="px-3.5 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-md cursor-pointer"
              >
                초기화 확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* (6) 3초 토스트 */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 right-5 z-50 bg-slate-900 text-white text-xs font-medium px-4 py-3 rounded-lg border border-slate-700 shadow-lg flex items-center gap-2.5 max-w-md"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            aria-label="알림 닫기"
            className="text-slate-400 hover:text-white shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
