{{- define "evalflow-app.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{- define "evalflow-app.databaseEnv" -}}
- name: PGHOST
  value: {{ required "database.host is required" .Values.database.host | quote }}
- name: PGPORT
  value: {{ .Values.database.port | quote }}
- name: PGDATABASE
  value: {{ required "database.name is required" .Values.database.name | quote }}
- name: PGUSER
  value: {{ required "database.username is required" .Values.database.username | quote }}
- name: PGPASSWORD
  valueFrom:
      secretKeyRef:
          name: {{ required "database.existingSecret is required" .Values.database.existingSecret | quote }}
          key: {{ required "database.passwordKey is required" .Values.database.passwordKey | quote }}
{{- end -}}
