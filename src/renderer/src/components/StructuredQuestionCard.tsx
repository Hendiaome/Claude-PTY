import { Check, CircleHelp, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { JSX } from "react";
import type {
  StructuredQuestion,
  StructuredQuestionAnswers,
  StructuredQuestionRequest
} from "../../../shared/types";
import { StructuredText } from "./StructuredText";

type StructuredQuestionCardProps = {
  request: StructuredQuestionRequest;
  onRespond: (requestId: string, answers: StructuredQuestionAnswers | null) => Promise<void>;
  onError: (message: string) => void;
};

/** AskUserQuestion 独立于普通工具权限，直接收集 Claude 需要的结构化答案。 */
export function StructuredQuestionCard({
  request,
  onRespond,
  onError
}: StructuredQuestionCardProps): JSX.Element {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const answers = buildAnswers(request.questions, selected, custom);
  const allAnswered = request.questions.every((question) => Boolean(answers[question.question]));

  const chooseOption = (question: StructuredQuestion, label: string): void => {
    setSelected((current) => {
      const currentValue = current[question.question];
      const previous = Array.isArray(currentValue) ? currentValue : [];
      const next = question.multiSelect
        ? previous.includes(label)
          ? previous.filter((value) => value !== label)
          : [...previous, label]
        : [label];
      return { ...current, [question.question]: next };
    });
    if (!question.multiSelect) {
      setCustom((current) => ({ ...current, [question.question]: "" }));
    }
  };

  const respond = async (nextAnswers: StructuredQuestionAnswers | null): Promise<void> => {
    if (submitting || (nextAnswers && !allAnswered)) {
      return;
    }
    setSubmitting(true);
    try {
      await onRespond(request.requestId, nextAnswers);
    } catch {
      // Hook 已把失败原因显示到工作区，保留当前答案便于直接重试。
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="structured-question-card">
      <div className="structured-question-card-title">
        <CircleHelp size={18} />
        <div>
          <strong>Claude 需要你确认</strong>
          <small>{request.questions.length} 个问题</small>
        </div>
      </div>

      <div className="structured-question-list">
        {request.questions.map((question, questionIndex) => {
          const selectedValue = selected[question.question];
          const selectedValues = Array.isArray(selectedValue) ? selectedValue : [];
          const currentCustom = custom[question.question];
          const customValue = typeof currentCustom === "string" ? currentCustom : "";
          return (
            <fieldset className="structured-question" key={`${question.question}-${questionIndex}`}>
              <legend>
                {question.header ? <span className="structured-question-header">{question.header}</span> : null}
                <StructuredText text={question.question} onError={onError} />
                <small>{question.multiSelect ? "可多选" : "单选"}</small>
              </legend>
              <div className="structured-question-options">
                {question.options.map((option) => {
                  const active = selectedValues.includes(option.label) && !(!question.multiSelect && customValue.trim());
                  return (
                    <button
                      className={active ? "selected" : ""}
                      type="button"
                      aria-pressed={active}
                      key={option.label}
                      onClick={() => chooseOption(question, option.label)}
                    >
                      <span className="structured-question-check">{active ? <Check size={13} /> : null}</span>
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                        {option.preview ? (
                          <details>
                            <summary>查看预览</summary>
                            <pre><StructuredText text={option.preview} onError={onError} /></pre>
                          </details>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              <label className="structured-question-custom">
                <span>其他答案</span>
                <textarea
                  rows={2}
                  placeholder={question.multiSelect ? "可与已选项一起提交" : "输入自定义答案"}
                  value={customValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustom((current) => ({ ...current, [question.question]: value }));
                    if (!question.multiSelect && value.trim()) {
                      setSelected((current) => ({ ...current, [question.question]: [] }));
                    }
                  }}
                />
              </label>
            </fieldset>
          );
        })}
      </div>

      <div className="structured-question-actions">
        {!allAnswered ? <span>请回答全部问题</span> : <span />}
        <button className="text-button" disabled={submitting} onClick={() => void respond(null)}>
          取消提问
        </button>
        <button
          className="text-button primary"
          disabled={!allAnswered || submitting}
          onClick={() => void respond(answers)}
        >
          {submitting ? <LoaderCircle className="spin" size={14} /> : null}
          提交答案
        </button>
      </div>
    </section>
  );
}

function buildAnswers(
  questions: StructuredQuestion[],
  selected: Record<string, string[]>,
  custom: Record<string, string>
): StructuredQuestionAnswers {
  const answers = Object.create(null) as StructuredQuestionAnswers;
  questions.forEach((question) => {
    const currentCustom = custom[question.question];
    const customAnswer = typeof currentCustom === "string" ? currentCustom.trim() : "";
    const currentSelected = selected[question.question];
    const selectedAnswers = Array.isArray(currentSelected) ? currentSelected : [];
    const values = question.multiSelect
      ? [...selectedAnswers, ...(customAnswer ? [customAnswer] : [])]
      : customAnswer
        ? [customAnswer]
        : selectedAnswers.slice(0, 1);
    if (values.length > 0) {
      answers[question.question] = values.join(", ");
    }
  });
  return answers;
}
