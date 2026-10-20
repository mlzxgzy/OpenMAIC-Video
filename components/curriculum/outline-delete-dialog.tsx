/**
 * 删一章 / 一节 / 一目前的确认框。
 *
 * 用一个统一的确认框而不是三层各写一个 `window.confirm`：三层删除的牵连面不同
 * （删章级联删节、删节让目退回「未归类」、删目把设计一起删掉），这些差别必须
 * 在确认框里逐条说清，而 `window.confirm` 的纯文本没法分行、没法被测试定位，
 * 也拦不住用户在没读完时连按回车。
 *
 * 文案由纯函数 `describeOutlineDelete` 生成（见 `lib/curriculum/outline-actions.ts`），
 * 因为它同时是"库里到底删了什么"的唯一说法，写进组件就只能靠肉眼保证它和
 * 外键行为一致。
 */
'use client';

import { Loader2, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { OutlineDeleteSpec } from '@/lib/curriculum/outline-actions';

export function OutlineDeleteDialog({
  open,
  onOpenChange,
  spec,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spec: OutlineDeleteSpec | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // 请求在飞的时候不许关：关掉会让用户以为"已经删完了"，而它可能刚失败。
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{spec?.title ?? '确认删除？'}</AlertDialogTitle>
          <AlertDialogDescription>
            {spec?.consequence ?? ''}
            {spec?.keep ? (
              <>
                <br />
                {spec.keep}
              </>
            ) : null}
            <br />
            删除后不能撤销。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            data-testid="outline-delete-confirm"
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // Radix 的 Action 点完就关框。这里的删除是一次网络请求，失败要能留在
              // 框里看到原因，所以自己关（成功后由父组件收起）。
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {spec?.confirmLabel ?? '删除'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
