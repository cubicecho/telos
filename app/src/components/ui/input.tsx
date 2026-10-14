import { useImperativeHandle, useRef } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { IconClassContext } from '@/components/ui/icons-base';
import {
  INPUT_CLASS,
  INPUT_LEADING_CLASS,
  INPUT_LEADING_PAD_CLASS,
  INPUT_SLOT_ICON_CLASS,
  INPUT_TRAILING_CLASS,
  INPUT_TRAILING_PAD_CLASS,
  INPUT_WRAPPER_CLASS,
  type InputAutoComplete,
  type InputHandle,
  type InputKeyPressEvent,
  type InputKeyPressHandler,
  type InputProps,
  type InputType,
  NATIVE_INPUT_MODE,
} from '@/components/ui/input-base';
import { cn, FIELD_INVALID_CLASS, isInvalid } from '@/lib/utils';

/** A one-line text box, with optional slots at its start and end. */
function Input({
  className,
  type = 'text',
  inputMode,
  value,
  defaultValue,
  onChangeText,
  onBlur,
  onSubmitEditing,
  onKeyPress,
  onEscape,
  placeholder,
  autoCapitalize,
  autoCorrect,
  autoComplete,
  maxLength,
  disabled,
  readOnly,
  autoFocus,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  leadingSlot,
  trailingSlot,
  wrapperClassName,
  ref,
}: InputProps) {
  const inner = useRef<TextInput>(null);
  useImperativeHandle<InputHandle, InputHandle>(ref, () => ({
    focus: () => inner.current?.focus(),
  }));

  const field = (
    <TextInput
      ref={inner}
      value={value}
      defaultValue={defaultValue}
      onChangeText={onChangeText}
      onBlur={onBlur}
      onSubmitEditing={onSubmitEditing}
      onKeyPress={(event) => {
        onKeyPress?.(event);
        // A caller's own handler that took the key keeps it, as on the web.
        if (event.isDefaultPrevented()) {
          return;
        }
        if (event.nativeEvent.key === 'Escape') {
          onEscape?.();
        }
      }}
      placeholder={placeholder}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      autoComplete={autoComplete}
      maxLength={maxLength}
      editable={disabled !== true && readOnly !== true}
      autoFocus={autoFocus}
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      // What react-native has no prop for, in the spelling react-native-web reads — the same
      // arrangement as `DateTimeInput`'s trigger.
      {...(Platform.OS === 'web'
        ? {
            ...(ariaDescribedBy === undefined ? {} : { 'aria-describedby': ariaDescribedBy }),
            ...(ariaInvalid === undefined ? {} : { 'aria-invalid': ariaInvalid }),
          }
        : {})}
      inputMode={inputMode ?? NATIVE_INPUT_MODE[type] ?? 'text'}
      secureTextEntry={type === 'password'}
      // What a DOM `type="search"` is without being told, so a screen reader on device says
      // "search field" too.
      role={type === 'search' ? 'searchbox' : undefined}
      className={cn(
        INPUT_CLASS,
        leadingSlot != null && INPUT_LEADING_PAD_CLASS,
        trailingSlot != null && INPUT_TRAILING_PAD_CLASS,
        isInvalid(ariaInvalid) && FIELD_INVALID_CLASS,
        disabled && 'opacity-50',
        className,
      )}
    />
  );

  if (leadingSlot == null && trailingSlot == null) {
    return field;
  }

  return (
    <View className={cn(INPUT_WRAPPER_CLASS, wrapperClassName)}>
      {field}
      <IconClassContext.Provider value={INPUT_SLOT_ICON_CLASS}>
        {leadingSlot != null ? <View className={INPUT_LEADING_CLASS}>{leadingSlot}</View> : null}
        {trailingSlot != null ? <View className={INPUT_TRAILING_CLASS}>{trailingSlot}</View> : null}
      </IconClassContext.Provider>
    </View>
  );
}

export type { InputAutoComplete, InputHandle, InputKeyPressEvent, InputKeyPressHandler, InputProps, InputType };
export { Input };
