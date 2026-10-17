/**
 * 科目管理：统一维护科目列表。
 *
 * 为什么需要独立管理：
 * 科目以前是每个任务自己的自由文本，打错一个字就会永久多出一个选项，
 * 而且没有任何办法改名或清理。现在科目是一份字典（`state.subjects`），
 * 任务仍然保存科目名，但改名/删除都通过这里完成：
 *   - 改名 → 同一次提交里把所有引用它的任务一起改名（任务与字典不会脱节）；
 *   - 删除 → 仍被引用时**拒绝**，并提示引用数量与前几个任务标题；
 *     也可以指定"换成另一个科目"后一起迁移，绝不留下无法识别的引用。
 *
 * 另外会列出"任务里用过但字典里没有"的历史科目（孤儿），可以一键收编。
 */

import { append, clear, el, toast } from '../dom.js';
import { button, card, pill } from '../components.js';
import { TASK_NAME_MAX_LENGTH } from '../../domain/validation.js';
import { confirmDialog } from '../modal.js';

/**
 * @param {object} options
 * @param {object} options.services
 * @param {() => void} [options.onChanged] 变更后的回调（通常是重新渲染当前页）
 */
export function renderSubjectManager({ services }) {
  const subjects = services.subjectService.listWithUsage();
  const orphans = services.subjectService.listOrphans();
  const newNameInput = el('input', {
    type: 'text',
    id: 'subject-new',
    maxlength: String(TASK_NAME_MAX_LENGTH),
    placeholder: '例如：高等数学',
  });
  const errorHost = el('div');

  function fail(issues) {
    clear(errorHost);
    const list = (issues ?? []).filter((issue) => issue.severity !== 'info');
    if (list.length === 0) return;
    append(errorHost, [
      el('div.notice.notice--danger', { role: 'alert' }, [
        el('div', {}, [
          el('div.notice__title', { text: '没有保存' }),
          el('ul', { style: { margin: 0, paddingLeft: '1.2em' } }, list.map((issue) => el('li', { text: issue.message }))),
        ]),
      ]),
    ]);
  }

  function addSubject() {
    const name = newNameInput.value.trim();
    if (!name) {
      fail([{ severity: 'error', message: '请填写科目名称。' }]);
      return;
    }
    const result = services.ui.saveSubject({ kind: 'subject.ensure', name });
    if (!result.ok) {
      fail(result.issues ?? []);
      return;
    }
    clear(errorHost);
    newNameInput.value = '';
    toast(`科目「${name}」已加入列表。`, 'success');
    services.ui.renderCurrent();
  }

  function renameSubject(subject, input) {
    const name = input.value.trim();
    if (!name || name === subject.name) return;
    const result = services.ui.saveSubject({ kind: 'subject.rename', subjectId: subject.id, name });
    if (!result.ok) {
      fail(result.issues ?? []);
      return;
    }
    toast(`已改名为「${name}」，引用它的任务也一起更新了。`, 'success');
    services.ui.renderCurrent();
  }

  async function removeSubject(subject) {
    if (subject.usageCount > 0) {
      const others = subjects.filter((item) => item.id !== subject.id);
      // 仍被引用：先要求用户指定替换科目，或先去改任务
      const replacement = others[0]?.name ?? null;
      const confirmed = replacement
        ? await confirmDialog({
            title: `「${subject.name}」还有 ${subject.usageCount} 个任务在用`,
            message: `可以直接把这 ${subject.usageCount} 个任务改成「${replacement}」，或者先到任务页逐个修改科目。`,
            bullets: [`替换为：${replacement}`, '不替换则本次不删除任何内容'],
            confirmLabel: `改用「${replacement}」并删除`,
            confirmVariant: 'primary',
          })
        : false;
      if (!confirmed) {
        fail([
          {
            severity: 'error',
            message: `「${subject.name}」还有 ${subject.usageCount} 个任务在用。请先把这些任务改成别的科目，再删除这个科目。`,
          },
        ]);
        return;
      }
      const result = services.ui.saveSubject({ kind: 'subject.remove', subjectId: subject.id, reassignTo: replacement });
      if (!result.ok) {
        fail(result.issues ?? []);
        return;
      }
      toast(`已删除「${subject.name}」，${subject.usageCount} 个任务已改为「${replacement}」。`, 'success');
      services.ui.renderCurrent();
      return;
    }

    const confirmed = await confirmDialog({
      title: `删除科目「${subject.name}」？`,
      message: '没有任务在使用这个科目，删除后它不会再出现在科目选择栏里。',
      confirmLabel: '删除',
      confirmVariant: 'danger',
    });
    if (!confirmed) return;
    const result = services.ui.saveSubject({ kind: 'subject.remove', subjectId: subject.id });
    if (!result.ok) {
      fail(result.issues ?? []);
      return;
    }
    toast(`已删除「${subject.name}」。`, 'success');
    services.ui.renderCurrent();
  }

  const body = el('div', {}, [
    subjects.length === 0
      ? el('div.card__hint', {
          text: '还没有科目。新建任务时填写的第一个科目会自动出现在这里；也可以直接在下面添加。',
        })
      : el(
          'div.table-wrap',
          {},
          [
            el('table', {}, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: '科目名称' }),
                  el('th', { text: '使用中的任务' }),
                  el('th', { text: '操作' }),
                ]),
              ]),
              el(
                'tbody',
                {},
                subjects.map((subject) => {
                  const input = el('input', {
                    type: 'text',
                    value: subject.name,
                    maxlength: String(TASK_NAME_MAX_LENGTH),
                    'aria-label': `${subject.name} 的新名称`,
                  });
                  return el('tr', {}, [
                    el('td', {}, [input]),
                    el('td', {}, [
                      subject.usageCount > 0 ? pill(`${subject.usageCount} 个任务`, 'neutral') : pill('未使用', 'success'),
                    ]),
                    el('td', {}, [
                      button('重命名', { size: 'sm', onClick: () => renameSubject(subject, input) }),
                      button('删除', { size: 'sm', variant: 'danger', onClick: () => removeSubject(subject) }),
                    ]),
                  ]);
                }),
              ),
            ]),
          ],
        ),
    orphans.length > 0
      ? el('div.notice.notice--warning', {}, [
          el('div', {}, [
            el('div.notice__title', { text: `有 ${orphans.length} 个历史科目不在列表里` }),
            el('div.card__hint', {
              text: '这些科目出现在已有任务上，但没有登记到科目列表。加入列表后就能统一改名或清理。',
            }),
            el(
              'div.form-actions',
              { style: { justifyContent: 'flex-start', flexWrap: 'wrap' } },
              orphans.map((item) =>
                button(`${item.name}（${item.usageCount}）`, {
                  size: 'sm',
                  onClick: () => {
                    const result = services.ui.saveSubject({ kind: 'subject.ensure', name: item.name });
                    if (!result.ok) {
                      fail(result.issues ?? []);
                      return;
                    }
                    services.ui.renderCurrent();
                  },
                }),
              ),
            ),
          ]),
        ])
      : null,
    el('div.form-actions', { style: { justifyContent: 'flex-start', marginTop: 'var(--space-3)' } }, [
      newNameInput,
      button('添加科目', { size: 'sm', variant: 'primary', onClick: addSubject }),
    ]),
    errorHost,
  ]);

  return card({
    title: '科目管理',
    hint: '科目选择栏以这里的列表为准；改名会让引用它的任务一起更新，删除前会先检查是否仍被使用',
    body,
  });
}
