import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { Zap } from 'lucide-react';

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const time = new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date());

        return (
          <Toast key={id} {...props} className="notification-toast">
            <div className="notification-reviewed" aria-hidden="true">
              <span className="notification-camera" />
              <span className="notification-reviewed-dot" />
              REVIEWED
            </div>
            <div className="notification-card">
              <div className="notification-icon" aria-hidden="true">
                <Zap size={44} strokeWidth={2.8} fill="currentColor" />
              </div>
              <div className="notification-copy">
                <div className="notification-status">
                  <span className="notification-status-dot" />
                  NEW
                </div>
                {title && (
                  <ToastTitle className="notification-title">
                    {title}
                  </ToastTitle>
                )}
                <div className="notification-meta">
                  {description && (
                    <ToastDescription className="notification-description">
                      {description}
                    </ToastDescription>
                  )}
                  <span className="notification-time">Today, {time}</span>
                </div>
                {action && (
                  <div className="notification-action">{action}</div>
                )}
              </div>
            </div>
            <ToastClose className="notification-close" />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
